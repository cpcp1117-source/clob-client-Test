/**
 * 🚀 BTC 5分鐘預測市場正式交易系統
 * 
 * 基於 btc-trading-simulator.ts 策略邏輯，執行真實下單
 * 流程: 下單 → 持倉監控 → 結算 → 領取獎勵（Redeem）
 * 
 * ⚠️ 警告: 此程式會使用真實資金，請謹慎操作
 */

import { config as dotenvConfig } from "dotenv";
import { resolve } from "path";
import { WebSocket } from "ws";
import { ethers, BigNumber, constants } from "ethers";
import { createWalletClient, http, type Hex, encodeFunctionData, zeroHash } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import { RelayClient, RelayerTxType } from "@polymarket/builder-relayer-client";
import { BuilderConfig } from "@polymarket/builder-signing-sdk";
import { 
    ClobClient, 
    Side, 
    OrderType, 
    AssetType,
    SignatureType,
    type ApiKeyCreds,
    Chain 
} from "../src/index.ts";
import { getContractConfig } from "../src/config.ts";
import { ctfAbi } from "../examples/abi/ctfAbi.ts";
import { usdcAbi } from "../examples/abi/usdcAbi.ts";

dotenvConfig({ path: resolve(import.meta.dirname, "../.env") });

// ============================================
// 🎛️ 策略配置
// ============================================
const CONFIG = {
    // 🔴 正式環境設定
    IS_MAINNET: true,                          // true = Polygon 主網, false = Amoy 測試網
    CHAIN_ID: 137 as Chain,                    // 137 = Polygon, 80002 = Amoy
    
    // 資金管理
    // (注意: 實際初始本金會自動抓取當前錢包真實餘額，見程式碼第 270 行)
    INITIAL_BALANCE: 0,                        // 初始本金會被自動覆寫為真實錢包餘額
    // (注意: 測試期間已將開單金額固定為 $1 USDC，下方乘數目前不作用，見程式碼第 706 行)
    STANDARD_MULTIPLIER: 1.0,                  
    DEFENSIVE_MULTIPLIER: 0.5,                 
    
    // 策略參數
    HIGH_PROB_THRESHOLD: 0.85,                 // 85% 高勝率門檻
    CONSECUTIVE_HITS: 5,                       // 連續達標次數
    MAX_LATENCY: 500,                          // 最大延遲 ms
    
    // 停損機制
    STOP_LOSS_THRESHOLD: 0.15,                 // 價格下跌 15% 觸發停損
    STOP_LOSS_CONFIRM_COUNT: 5,                // 需連續 N 次低於閾值才觸發停損
    STOP_LOSS_HOLD_SECONDS: 5,                 // 最後 N 秒不執行停損
    REBUY_WAIT_UNTIL_SECONDS: 5,               // 停損後等到最後 N 秒才能重新下單
    MIN_REBUY_PROB: 0.85,                      // 重新買入最低勝率 85%
    MAX_REBUY_PER_ROUND: 1,                    // 每輪最多重新下單次數
    
    // 時間視窗 (秒)
    MONITORING_START: 30,                      // 監控期開始 (剩餘30秒)
    MONITORING_END: 15,                        // 監控期結束 (剩餘15秒)
    FINAL_DECISION_TIME: 5,                    // 最後決策時間點 (剩餘5秒)
    LOCK_TIME: 2,                              // 鎖定期 (剩餘2秒以下)
    
    // 結算與領獎
    REDEEM_DELAY: 240000,                      // 市場結束後等待多久才領獎 (4分鐘)
    REDEEM_CHECK_INTERVAL: 30000,              // 檢查可領獎間隔 (30秒)
    
    // API 設定
    CLOB_API_URL: process.env.CLOB_API_URL || "https://clob.polymarket.com",
    WEBSOCKET_URL: process.env.WS_URL || "wss://ws-subscriptions-clob.polymarket.com",
    GAMMA_API_URL: "https://gamma-api.polymarket.com",
    RPC_URL: process.env.RPC_URL || "https://polygon-rpc.com",
    RELAYER_URL: "https://relayer-v2.polymarket.com",
    
    // 安全設定
    MIN_REQUEST_INTERVAL: 200,                 // 請求最小間隔 ms
    WS_RECONNECT_DELAY: 1000,
    WS_PING_INTERVAL: 15000,
    
    // Gas 設定 (Polygon)
    GAS_PRICE: 100_000_000_000,                // 100 Gwei
    GAS_LIMIT_APPROVE: 200_000,
    GAS_LIMIT_REDEEM: 300_000,
};

// ============================================
// 📊 狀態機定義
// ============================================
enum TradingState {
    WAITING = "WAITING",
    MONITORING = "MONITORING",
    FINAL_DECISION = "FINAL_DECISION",
    ORDERED = "ORDERED",
    HOLDING = "HOLDING",
    COOLDOWN = "COOLDOWN",
    SKIPPED = "SKIPPED",
    SETTLING = "SETTLING",
}

interface LiveOrder {
    id: string;
    orderId: string;                           // 真實訂單 ID
    marketSlug: string;
    conditionId: string;                       // 用於 redeem
    tokenId: string;                           // 下單的 token ID
    side: "UP" | "DOWN";
    price: number;
    amount: number;
    shares: number;                            // 購買的股數
    potentialReturn: number;
    orderType: "STANDARD" | "DEFENSIVE";
    timestamp: Date;
    timeRemaining: number;
    status: "PENDING" | "FILLED" | "PARTIAL" | "CANCELLED" | "FAILED";
    finalPrices?: { up: number; down: number };
}

interface PendingRedeem {
    conditionId: string;
    marketSlug: string;
    side: "UP" | "DOWN";
    shares: number;
    entryPrice: number;
    marketEndTime: Date;
    redeemAttempts: number;
}

interface TradingSystemState {
    isRunning: boolean;
    tradingState: TradingState;
    balance: number;
    
    // 市場資訊
    currentMarket: any | null;
    lastMarketFetch: number;
    
    // 價格追蹤
    lastPrices: { up: number; down: number };
    wsConnected: boolean;
    priceUpdateCount: number;
    lastPriceUpdate: number;
    
    // 策略狀態
    consecutiveHighProb: { up: number; down: number };
    currentRoundOrder: LiveOrder | null;
    finalDecisionMade: boolean;
    monitoringSkipped: boolean;
    
    // 停損相關
    currentPosition: { side: "UP" | "DOWN"; entryPrice: number; amount: number; shares: number; tokenId: string } | null;
    stopLossTriggered: boolean;
    rebuyCount: number;
    stopLossConfirmCount: number;
    
    // 待領獎列表
    pendingRedeems: PendingRedeem[];
    
    // 統計
    totalRounds: number;
    wins: number;
    losses: number;
    skipped: number;
    stopLossCount: number;
    stopLossTotalAmount: number;
    totalWinAmount: number;
    totalRedeemed: number;
}

// ============================================
// 🔧 全域狀態與客戶端
// ============================================
let clobClient: ClobClient | null = null;
let wallet: ethers.Wallet | null = null;
let ctfContract: ethers.Contract | null = null;
let usdcContract: ethers.Contract | null = null;
let relayClient: RelayClient | null = null;

const state: TradingSystemState = {
    isRunning: false,
    tradingState: TradingState.WAITING,
    balance: CONFIG.INITIAL_BALANCE,
    
    currentMarket: null,
    lastMarketFetch: 0,
    
    lastPrices: { up: 0, down: 0 },
    wsConnected: false,
    priceUpdateCount: 0,
    lastPriceUpdate: 0,
    
    consecutiveHighProb: { up: 0, down: 0 },
    currentRoundOrder: null,
    finalDecisionMade: false,
    monitoringSkipped: false,
    
    currentPosition: null,
    stopLossTriggered: false,
    rebuyCount: 0,
    stopLossConfirmCount: 0,
    
    pendingRedeems: [],
    
    totalRounds: 0,
    wins: 0,
    losses: 0,
    skipped: 0,
    stopLossCount: 0,
    stopLossTotalAmount: 0,
    totalWinAmount: 0,
    totalRedeemed: 0,
};

let cachedTokenIds: { up: string; down: string } | null = null;
let outcomeLabels = { up: "Up", down: "Down" };

// 🔒 防重入鎖: 防止 WebSocket 高頻回呼導致並行多次下單
let orderLock = false;

// WebSocket
let priceWebSocket: WebSocket | null = null;
let pingInterval: NodeJS.Timeout | null = null;
let subscribedTokenIds: { up: string; down: string } | null = null;
let wsConnectionId = 0;
let globalOnPriceCallback: ((prices: { up: number; down: number }) => void) | null = null;

console.log("✅ 正式交易系統模組載入完成");
console.log(`   網路: ${CONFIG.IS_MAINNET ? "Polygon 主網" : "Amoy 測試網"}`);
console.log(`   初始本金: $${CONFIG.INITIAL_BALANCE}`);

// ============================================
// 🔐 初始化交易客戶端
// ============================================
async function initializeTradingClient(): Promise<boolean> {
    console.log("\n🔐 初始化交易客戶端...");
    
    const privateKey = process.env.PK;
    if (!privateKey) {
        console.error("❌ 錯誤: 缺少 PK (私鑰) 環境變數");
        return false;
    }
    
    try {
        // ============================================
        // 參照 test-trade-flow.ts 的成功連線模式
        // 核心: 先用不帶 Provider 的 Wallet 建立 ClobClient
        //       簽章類型自動判斷: 有 FUNDER_ADDRESS → POLY_GNOSIS_SAFE
        // ============================================
        
        // 建立 Wallet (不帶 provider，純粹用於簽章)
        wallet = new ethers.Wallet(privateKey);
        const address = await wallet.getAddress();
        console.log(`   錢包地址: ${address}`);
        
        // 判斷簽章類型：有 FUNDER_ADDRESS 表示使用 Polymarket 代理錢包
        const funderAddress = process.env.FUNDER_ADDRESS;
        const sigType = funderAddress ? SignatureType.POLY_GNOSIS_SAFE : SignatureType.EOA;
        console.log(`   簽章類型: ${funderAddress ? "POLY_GNOSIS_SAFE (代理錢包)" : "EOA (直接錢包)"}`);
        if (funderAddress) {
            console.log(`   代理錢包: ${funderAddress}`);
        }
        
        // 取得或建立 API 憑證
        const tempClient = new ClobClient(CONFIG.CLOB_API_URL, CONFIG.CHAIN_ID, wallet);
        const creds = await tempClient.createOrDeriveApiKey();
        console.log(`   API Key: ${creds.key.slice(0, 10)}...`);
        
        // 初始化完整客戶端 (使用正確的簽章類型)
        clobClient = new ClobClient(
            CONFIG.CLOB_API_URL,
            CONFIG.CHAIN_ID,
            wallet,
            creds,
            sigType,
            funderAddress
        );
        
        // 取得 Polymarket 平台（含代理錢包）的餘額
        let balanceFormatted = 0;
        const balanceResponse: any = await clobClient.getBalanceAllowance({ asset_type: "COLLATERAL" as any });
        if (balanceResponse && typeof balanceResponse.balance !== "undefined") {
            balanceFormatted = parseFloat(balanceResponse.balance) / 1e6;
        } else {
            console.warn("   ⚠️ 無法從 API 取得餘額，回傳格式:", balanceResponse);
        }
        console.log(`   USDC 餘額: $${balanceFormatted.toFixed(2)}`);
        
        // 將初始本金與狀態本金都設為當前帳戶的真實餘額
        CONFIG.INITIAL_BALANCE = balanceFormatted;
        state.balance = balanceFormatted;
        
        // 嘗試連接 RPC (選用，僅供 Redeem 領獎使用)
        try {
            const rpcUrls = [
                process.env.RPC_URL,                           // .env 設定優先
                "https://1rpc.io/matic",                       // 1RPC (穩定)
                "https://polygon.meowrpc.com",                 // MeowRPC
                "https://rpc.ankr.com/polygon",                // Ankr
                "https://polygon-rpc.com",                     // 官方
                "https://polygon-bor-rpc.publicnode.com"       // PublicNode (排最後)
            ].filter(url => url && typeof url === "string");
            
            for (const url of rpcUrls) {
                try {
                    const provider = new ethers.providers.JsonRpcProvider(url as string);
                    await provider.getNetwork();
                    // 重新建立帶 provider 的 wallet (供合約呼叫使用)
                    wallet = new ethers.Wallet(privateKey, provider);
                    const contractConfig = getContractConfig(CONFIG.CHAIN_ID);
                    ctfContract = new ethers.Contract(contractConfig.conditionalTokens, ctfAbi, wallet);
                    usdcContract = new ethers.Contract(contractConfig.collateral, usdcAbi, wallet);
                    console.log(`   RPC 連接成功: ${url} (用於 Redeem)`);
                    break;
                } catch {
                    // 繼續嘗試下一個
                }
            }
            if (!ctfContract) {
                console.log("   ⚠️ 所有 RPC 節點都無法連接，Redeem 功能將無法使用（不影響下單）");
            }
        } catch {
            console.log("   ⚠️ RPC 連接失敗，Redeem 功能將無法使用（不影響下單）");
        }
        
        // 初始化 Relayer 客戶端 (用於代理錢包領獎 / Gasless)
        if (funderAddress) {
            try {
                console.log(`   🔧 初始化 Relayer 客戶端 (用於 Safe 領獎)...`);
                
                // 1. 建立 Viem WalletClient (具備網路連線能力的 Provider)
                const account = privateKeyToAccount(privateKey as Hex);
                const viemWallet = createWalletClient({
                    account,
                    chain: polygon,
                    transport: http(process.env.RPC_URL || "https://polygon-rpc.com")
                });

                // 2. 獲取 Builder 認證配置
                let builderConfig: BuilderConfig | undefined;
                const bKey = process.env.BUILDER_API_KEY;
                const bSecret = process.env.BUILDER_SECRET;
                const bPass = process.env.BUILDER_PASS_PHRASE;

                if (bKey && bSecret && bPass) {
                    console.log(`      使用 .env 中的 Builder 金鑰進行授權...`);
                    builderConfig = new BuilderConfig({
                        localBuilderCreds: {
                            key: bKey,
                            secret: bSecret,
                            passphrase: bPass
                        }
                    });
                } else {
                    console.log(`      ⚠️ .env 未發現 Builder 金鑰，嘗試自動衍生以避免 401 錯誤...`);
                    try {
                        const tempEthersWallet = new ethers.Wallet(privateKey);
                        const tempClobClient = new ClobClient(CONFIG.CLOB_API_URL, CONFIG.CHAIN_ID, tempEthersWallet);
                        const creds = await tempClobClient.createOrDeriveApiKey();
                        const authClobClient = new ClobClient(CONFIG.CLOB_API_URL, CONFIG.CHAIN_ID, tempEthersWallet, creds);
                        const builderKeys = await authClobClient.createBuilderApiKey();
                        
                        builderConfig = new BuilderConfig({
                            localBuilderCreds: {
                                key: builderKeys.key,
                                secret: builderKeys.secret,
                                passphrase: builderKeys.passphrase
                            }
                        });
                        console.log(`      ✅ 已自動衍生 Builder 認證`);
                    } catch (err: any) {
                        console.warn(`      ❌ 自動衍生 Builder 金鑰失敗: ${err.message}`);
                    }
                }

                // 3. 建立 RelayClient
                relayClient = new RelayClient(
                    CONFIG.RELAYER_URL,
                    CONFIG.CHAIN_ID,
                    viemWallet as any,
                    builderConfig as any,
                    RelayerTxType.SAFE
                );
                console.log(`   ✅ Relayer 客戶端初始化成功`);
            } catch (err: any) {
                console.warn(`   ⚠️ Relayer 客戶端初始化失敗: ${err.message}`);
                console.warn(`   ℹ️ 領獎功能將無法使用，請至網頁手動操作`);
            }
        }
        
        console.log("✅ 交易客戶端初始化完成\n");
        return true;
        
    } catch (error) {
        console.error("❌ 初始化失敗:", error);
        return false;
    }
}

// ============================================
// ✅ 檢查並設置授權
// ============================================
async function checkAndSetApprovals(): Promise<boolean> {
    if (!wallet || !usdcContract || !ctfContract) {
        console.log("🔑 合約授權檢查...");
        console.log("   ⚠️ 合約未初始化（RPC 未連接），跳過授權步驟");
        console.log("   ℹ️ 下單與停損透過 Polymarket API 執行，不需要鏈上授權");
        console.log("   ℹ️ 唯有 Redeem 領獎才需要鏈上授權（可在網頁手動操作）\n");
        return true;
    }
    
    console.log("🔑 檢查合約授權...");
    
    // 💡 代理錢包 (Proxy Wallet) 處理：
    // 如果使用代理錢包，USDC 授權是由代理錢包合約處理的，通常由 API 自動完成。
    // 手動執行 EOA 的 approve 是多餘且容易報錯的（因為 EOA 可能沒有 USDC）。
    if (process.env.FUNDER_ADDRESS) {
        console.log("   ℹ️ 偵測到代理錢包，授權由 Polymarket 自動處理，跳過手動步驟");
        console.log("   ✅ 錢包檢查完成\n");
        return true;
    }
    
    try {
        const address = await wallet.getAddress();
        
        // 🔍 先檢查 MATIC 餘額
        const maticBalance = await wallet.getBalance();
        const maticFormatted = parseFloat(ethers.utils.formatEther(maticBalance));
        console.log(`   MATIC 餘額: ${maticFormatted.toFixed(6)} MATIC`);
        
        if (maticFormatted < 0.001) {
            console.warn(`\n   ⚠️ MATIC 餘額不足，跳過鏈上授權步驟`);
            console.warn(`   💡 請轉入約 0.5~1 MATIC 到 ${address} 以啟用自動領獎\n`);
            return true;
        }
        
        const contractConfig = getContractConfig(CONFIG.CHAIN_ID);
        
        // 檢查 USDC 對 Exchange 的授權
        const usdcAllowance = await usdcContract.allowance(address, contractConfig.exchange);
        if (usdcAllowance.eq(0)) {
            console.log("   設定 USDC → Exchange 授權...");
            // 取得 pending nonce 以避免跟交易池中的交易衝突
            const nonce = await wallet!.getTransactionCount("pending");
            console.log(`   使用 nonce: ${nonce}`);
            const tx = await usdcContract.approve(
                contractConfig.exchange, 
                constants.MaxUint256,
                { 
                    nonce,
                    maxFeePerGas: ethers.utils.parseUnits("250", "gwei"),
                    maxPriorityFeePerGas: ethers.utils.parseUnits("60", "gwei"),
                    gasLimit: CONFIG.GAS_LIMIT_APPROVE 
                }
            );
            console.log(`   ⏳ 等待授權確認...`);
            await tx.wait();
            console.log(`   ✅ 授權完成: ${tx.hash}`);
        } else {
            console.log("   ✅ USDC → Exchange 已授權");
        }
        
        // 檢查 CTF 對 Exchange 的授權
        const ctfApproved = await ctfContract.isApprovedForAll(address, contractConfig.exchange);
        if (!ctfApproved) {
            console.log("   設定 CTF → Exchange 授權...");
            const ctfNonce = await wallet!.getTransactionCount("pending");
            const tx = await ctfContract.setApprovalForAll(
                contractConfig.exchange, 
                true,
                { 
                    nonce: ctfNonce,
                    maxFeePerGas: ethers.utils.parseUnits("250", "gwei"),
                    maxPriorityFeePerGas: ethers.utils.parseUnits("60", "gwei"),
                    gasLimit: CONFIG.GAS_LIMIT_APPROVE 
                }
            );
            console.log(`   ⏳ 等待授權確認...`);
            await tx.wait();
            console.log(`   ✅ 授權完成: ${tx.hash}`);
        } else {
            console.log("   ✅ CTF → Exchange 已授權");
        }
        
        console.log("✅ 授權檢查完成\n");
        return true;
        
    } catch (error: any) {
        if (error.message?.includes("underpriced") || error.message?.includes("fee too low")) {
            console.error("❌ 授權設置失敗: 交易池中已有相同 Nonce 且 Gas 較高的交易");
            console.error("   💡 建議: 請稍候再試，或手動在 PolygonScan 檢查是否有卡住的交易");
        } else {
            console.error("❌ 授權設置失敗:", error.message || error);
        }
        console.warn("   ℹ️ 繼續執行下單邏輯（下單不需要鏈上授權）\n");
        return true;
    }
}

// ============================================
// 💰 真實下單
// ============================================
async function executeRealOrder(
    tokenId: string,
    side: "UP" | "DOWN",
    price: number,
    amount: number,
    orderType: "STANDARD" | "DEFENSIVE",
    timeRemaining: number,
    market: any,
    slippage: number = 0.02 // 預設 2% 滑點
): Promise<LiveOrder | null> {
    if (!clobClient) {
        console.error("❌ CLOB 客戶端未初始化");
        return null;
    }
    
    try {
        // 計算股數 (shares = amount / price)
        const shares = Math.floor((amount / price) * 100) / 100;
        
        // 獲取市場參數
        const tickSize = market.minimum_tick_size || "0.01";
        const negRisk = market.neg_risk || false;
        
        console.log(`\n${"=".repeat(50)}`);
        console.log(`🚀 執行真實下單 [${orderType}]`);
        console.log(`   方向: ${side} (${outcomeLabels[side.toLowerCase() as "up" | "down"]})`);
        console.log(`   Token ID: ${tokenId.slice(0, 20)}...`);
        console.log(`   價格: ${(price * 100).toFixed(2)}%`);
        console.log(`   金額: $${amount.toFixed(2)}`);
        console.log(`   股數: ${shares.toFixed(2)}`);
        console.log(`   剩餘時間: ${timeRemaining}s`);
        
        // 計算「市價 (含滑點)」下單。Polymarket 中 10% 以上滑點基本等同於市價單
        // 因為 FAK 會自動為您匹配訂單簿上最優的價格直到撮合完成
        const cappedPrice = Math.min(0.99, price + slippage);
        
        console.log(`   模式: 市價買入 (Market Buy)`);
        console.log(`   滑點價格限制: ${(cappedPrice * 100).toFixed(2)}% (+${(slippage * 100).toFixed(2)}%)`);
        
        const response = await clobClient.createAndPostMarketOrder(
            {
                tokenID: tokenId,
                amount: amount,
                side: Side.BUY,
                orderType: OrderType.FAK,
                price: cappedPrice, 
            },
            { tickSize, negRisk },
            OrderType.FAK
        );
        
        if (response.success === false || response.error) {
            const errorMsg = response.errorMsg || response.error;
            console.error(`   ❌ 下單失敗: ${errorMsg}`);
            
            // 特殊錯誤提示
            if (JSON.stringify(response).includes("fully filled")) {
                console.warn(`   💡 提示: 訂單簿深度不足或價格波動過快，已自動取消剩餘部分`);
            }
            return null;
        }
        
        console.log(`   訂單回應:`, JSON.stringify(response).slice(0, 200));
        
        const orderId = response.orderID || response.id || `ORD-${Date.now()}`;
        console.log(`   ✅ 下單成功! 訂單 ID: ${orderId}`);
        console.log(`${"=".repeat(50)}\n`);
        
        // 更新餘額
        state.balance -= amount;
        
        const order: LiveOrder = {
            id: `LIVE-${Date.now()}`,
            orderId,
            marketSlug: market.slug,
            conditionId: market.conditionId || market.condition_id,
            tokenId,
            side,
            price,
            amount,
            shares,
            potentialReturn: shares,  // 勝利時獲得的股數
            orderType,
            timestamp: new Date(),
            timeRemaining,
            status: "FILLED",
        };
        
        return order;
        
    } catch (error) {
        console.error(`❌ 下單錯誤:`, error);
        return null;
    }
}

// ============================================
// 📤 停損賣出
// ============================================
async function executeSellOrder(tokenId: string, shares: number): Promise<boolean> {
    if (!clobClient) return false;
    
    try {
        console.log(`\n🔻 執行停損賣出: ${shares} 股`);
        
        const response = await clobClient.createAndPostMarketOrder(
            {
                tokenID: tokenId,
                amount: shares,
                side: Side.SELL,
                orderType: OrderType.FAK,
            },
            { tickSize: "0.01" },
            OrderType.FAK
        );
        
        if (response.success === false || response.error) {
            console.error(`   ❌ 賣出失敗: ${response.errorMsg || response.error}`);
            return false;
        }
        
        console.log(`   ✅ 停損賣出成功`);
        return true;
        
    } catch (error) {
        console.error(`❌ 停損賣出錯誤:`, error);
        return false;
    }
}

// ============================================
// 🎁 領取獎勵 (Redeem) - 支援 Safe 代理錢包
// ============================================

async function redeemPositions(conditionId: string, marketSlug: string = "unknown"): Promise<boolean> {
    const contractConfig = getContractConfig(CONFIG.CHAIN_ID);
    
    console.log(`\n🎁 領取獎勵...`);
    console.log(`   Condition ID: ${conditionId.slice(0, 20)}...`);

    // --------------------------------------------
    // 優先模式: Relayer (Gasless / Safe 錢包首選)
    // --------------------------------------------
    if (relayClient) {
        console.log(`   模式: Relayer SDK (Safe Gasless)...`);
        try {
            // CTF redeemPositions ABI (正規 viem 格式)
            const ctfRedeemAbi = [
                {
                    name: "redeemPositions",
                    type: "function",
                    stateMutability: "nonpayable",
                    inputs: [
                        { name: "collateralToken", type: "address" },
                        { name: "parentCollectionId", type: "bytes32" },
                        { name: "conditionId", type: "bytes32" },
                        { name: "indexSets", type: "uint256[]" }
                    ],
                    outputs: []
                }
            ] as const;

            const calldata = encodeFunctionData({
                abi: ctfRedeemAbi,
                functionName: "redeemPositions",
                args: [
                    contractConfig.collateral as Hex,
                    zeroHash,
                    conditionId as Hex,
                    [BigInt(1), BigInt(2)]
                ]
            });
            
            const redeemTx = {
                to: contractConfig.conditionalTokens,
                data: calldata,
                value: "0"
            };
            
            console.log(`   ⏳ 發送 Relayer 交易...`);
            const response = await relayClient.execute([redeemTx], `redeem ${conditionId.slice(0, 10)}`);
            console.log(`   📤 Relayer 交易已提交! ID: ${response.transactionID}`);
            
            console.log(`   ⏳ 等待交易確認...`);
            const result = await response.wait();
            
            if (result && result.transactionHash) {
                console.log(`   ✅ 領取成功! Hash: ${result.transactionHash}`);
                state.totalRedeemed++;
                return true;
            }
        } catch (error: any) {
            const errMsg = error.message || JSON.stringify(error);
            if (errMsg.includes("revert") || errMsg.includes("insufficient") || errMsg.includes("execution reverted")) {
                console.log(`   ℹ️ 無可領取餘額 (可能已領取或該方輸了)`);
                return true;
            }
            console.error(`   ❌ Relayer 領取失敗:`, errMsg);
        }
    }
    
    // --------------------------------------------
    // 備用模式: EOA 直接呼叫
    // --------------------------------------------
    if (ctfContract && wallet) {
        try {
            console.log(`   模式: EOA 直接呼叫`);
            const redeemNonce = await wallet.getTransactionCount("pending");
            const tx = await ctfContract.redeemPositions(
                contractConfig.collateral,
                ethers.constants.HashZero,
                conditionId,
                [1, 2],
                { 
                    nonce: redeemNonce,
                    maxFeePerGas: ethers.utils.parseUnits("250", "gwei"),
                    maxPriorityFeePerGas: ethers.utils.parseUnits("60", "gwei"),
                    gasLimit: CONFIG.GAS_LIMIT_REDEEM 
                }
            );
            
            console.log(`   交易送出: ${tx.hash}`);
            const receipt = await tx.wait();
            if (receipt.status === 1) {
                console.log(`   ✅ 領取成功! (EOA 直接模式)`);
                state.totalRedeemed++;
                return true;
            }
        } catch (error: any) {
            const errMsg = error.message || "";
            if (errMsg.includes("revert") || errMsg.includes("insufficient")) {
                console.log(`   ℹ️ 無可領取餘額 (可能已領取或輸了)`);
                return true;
            }
            console.error(`   ❌ 直接領取錯誤:`, errMsg);
        }
    }

    console.error("   ❌ 無法領取: 請至 Polymarket 網頁手動處理");
    return false;
}

// ============================================
// 🔄 處理待領獎項目
// ============================================
async function processPendingRedeems(): Promise<void> {
    if (state.pendingRedeems.length === 0) return;
    
    const now = Date.now();
    const toRemove: number[] = [];
    
    for (let i = 0; i < state.pendingRedeems.length; i++) {
        const item = state.pendingRedeems[i];
        
        // 檢查是否已過等待時間
        const waitTime = now - item.marketEndTime.getTime();
        if (waitTime < CONFIG.REDEEM_DELAY) {
            continue;
        }
        
        console.log(`\n📊 處理待領獎: ${item.marketSlug}`);
        
        const success = await redeemPositions(item.conditionId);
        
        if (success) {
            toRemove.push(i);
        } else {
            item.redeemAttempts++;
            if (item.redeemAttempts >= 5) {
                console.log(`   ⚠️ 已嘗試 5 次，放棄領獎`);
                toRemove.push(i);
            }
        }
    }
    
    // 移除已處理的項目（從後往前移除避免索引錯亂）
    for (let i = toRemove.length - 1; i >= 0; i--) {
        state.pendingRedeems.splice(toRemove[i], 1);
    }
    
    // 如果有處理任何項目（不論輸贏），都重新同步一次餘額
    if (toRemove.length > 0) {
        await syncBalance();
    }
}

// ============================================
// 💰 同步最新餘額
// ============================================
async function syncBalance(): Promise<void> {
    if (!clobClient) return;
    try {
        const response: any = await clobClient.getBalanceAllowance({ asset_type: "COLLATERAL" as any });
        if (response && typeof response.balance !== "undefined") {
            const newBalance = parseFloat(response.balance) / 1e6;
            if (newBalance !== state.balance) {
                console.log(`\n💰 餘額已更新: $${state.balance.toFixed(2)} → $${newBalance.toFixed(2)}`);
                state.balance = newBalance;
            }
        }
    } catch (error) {
        console.error("❌ 同步餘額失敗:", error);
    }
}

// ============================================
// 📡 WebSocket 價格訂閱
// ============================================
function connectPriceWebSocket(
    tokenIds: { up: string; down: string },
    onPrice: (prices: { up: number; down: number }) => void,
    isReconnect: boolean = false
) {
    wsConnectionId++;
    const thisConnectionId = wsConnectionId;
    
    globalOnPriceCallback = onPrice;
    subscribedTokenIds = { ...tokenIds };
    
    if (pingInterval) {
        clearInterval(pingInterval);
        pingInterval = null;
    }
    
    if (priceWebSocket) {
        try {
            priceWebSocket.on("error", () => {});
            priceWebSocket.close();
        } catch {}
        priceWebSocket = null;
    }
    
    const wsUrl = `${CONFIG.WEBSOCKET_URL}/ws/market`;
    if (!isReconnect) {
        console.log(`📡 連接 WebSocket: ${wsUrl}`);
    }
    
    const ws = new WebSocket(wsUrl);
    priceWebSocket = ws;
    
    ws.on("open", () => {
        if (wsConnectionId !== thisConnectionId) return;
        if (!isReconnect) console.log("✅ WebSocket 連接成功");
        state.wsConnected = true;
        
        ws.send(JSON.stringify({
            type: "market",
            assets_ids: [subscribedTokenIds!.up, subscribedTokenIds!.down],
            initial_dump: true,
        }));
        
        pingInterval = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) ws.send("PING");
        }, CONFIG.WS_PING_INTERVAL);
    });
    
    ws.on("message", (data: Buffer) => {
        if (wsConnectionId !== thisConnectionId) return;
        const msg = data.toString();
        if (msg === "PONG" || !subscribedTokenIds || !globalOnPriceCallback) return;
        
        try {
            const parsed = JSON.parse(msg);
            const prices = { ...state.lastPrices };
            let hasUpdate = false;
            
            const items = Array.isArray(parsed) ? parsed : [parsed];
            for (const item of items) {
                const newPrice = parseFloat(item.price || item.mid || "0");
                if (newPrice > 0) {
                    if (item.asset_id === subscribedTokenIds.up) {
                        prices.up = newPrice;
                        hasUpdate = true;
                    } else if (item.asset_id === subscribedTokenIds.down) {
                        prices.down = newPrice;
                        hasUpdate = true;
                    }
                }
            }
            
            if (hasUpdate) {
                state.priceUpdateCount++;
                state.lastPriceUpdate = Date.now();
                globalOnPriceCallback(prices);
            }
        } catch {}
    });
    
    ws.on("error", () => { state.wsConnected = false; });
    ws.on("close", () => {
        if (wsConnectionId !== thisConnectionId) return;
        state.wsConnected = false;
        if (pingInterval) clearInterval(pingInterval);
        
        if (state.isRunning && subscribedTokenIds && globalOnPriceCallback) {
            setTimeout(() => {
                if (state.isRunning) connectPriceWebSocket(subscribedTokenIds!, globalOnPriceCallback!, true);
            }, CONFIG.WS_RECONNECT_DELAY);
        }
    });
}

// ============================================
// 📊 獲取市場資訊
// ============================================
async function getCurrentBTC5MinMarket(): Promise<any | null> {
    const now = Date.now();
    if (state.currentMarket && (now - state.lastMarketFetch) < 60000) {
        const endTime = state.currentMarket.endDate || state.currentMarket.end_date_iso;
        if (endTime && new Date(endTime).getTime() > now) {
            return state.currentMarket;
        }
    }
    
    try {
        const nowSec = Math.floor(now / 1000);
        const currentWindow = Math.floor(nowSec / 300) * 300;
        const nextWindow = currentWindow + 300;
        
        const slugs = [`btc-updown-5m-${currentWindow}`, `btc-updown-5m-${nextWindow}`];
        const promises = slugs.map(slug =>
            fetch(`${CONFIG.GAMMA_API_URL}/markets?slug=${slug}`).then(r => r.json()).catch(() => [])
        );
        
        const results = await Promise.all(promises);
        for (const markets of results) {
            if (markets?.[0]?.active && !markets[0].closed) {
                state.lastMarketFetch = now;
                return markets[0];
            }
        }
        return null;
    } catch (error) {
        console.error("❌ 獲取市場失敗:", error);
        return null;
    }
}

// ============================================
// 🔄 提取 Token IDs
// ============================================
function extractTokenIds(market: any): { up: string; down: string } | null {
    if (market.clobTokenIds) {
        try {
            const tokenIds = typeof market.clobTokenIds === "string" 
                ? JSON.parse(market.clobTokenIds) : market.clobTokenIds;
            if (Array.isArray(tokenIds) && tokenIds.length >= 2) {
                if (market.outcomes) {
                    try {
                        const outcomes = typeof market.outcomes === "string" 
                            ? JSON.parse(market.outcomes) : market.outcomes;
                        if (Array.isArray(outcomes) && outcomes.length >= 2) {
                            outcomeLabels = { up: outcomes[0], down: outcomes[1] };
                        }
                    } catch {}
                }
                return { up: tokenIds[0], down: tokenIds[1] };
            }
        } catch {}
    }
    return null;
}

// ============================================
// 💰 計算下注金額
// ============================================
function calculateBetAmount(orderType: "STANDARD" | "DEFENSIVE"): number {
    // 🧪 測試模式：依照指示固定最低開單為 $1 USDC
    // 為了安全測試整個「下單 > 停損 > 領獎」流程，我們先固定這個金額
    return 1;
}

// ============================================
// 📺 顯示狀態
// ============================================
function displayStatus(prices: { up: number; down: number }, timeRemaining: number) {
    const now = new Date().toLocaleTimeString("zh-TW");
    const wsStatus = state.wsConnected ? "🟢" : "🟡";
    const stateEmoji: Record<TradingState, string> = {
        [TradingState.WAITING]: "⏳",
        [TradingState.MONITORING]: "👀",
        [TradingState.FINAL_DECISION]: "⚡",
        [TradingState.ORDERED]: "✅",
        [TradingState.HOLDING]: "📊",
        [TradingState.COOLDOWN]: "❄️",
        [TradingState.SKIPPED]: "⏭️",
        [TradingState.SETTLING]: "📊",
    };
    
    const mins = Math.floor(timeRemaining / 60);
    const secs = timeRemaining % 60;
    
    process.stdout.write(
        `\r[${now}] ${wsStatus} | ${outcomeLabels.up}: ${(prices.up * 100).toFixed(2)}% | ${outcomeLabels.down}: ${(prices.down * 100).toFixed(2)}% | ⏱️ ${mins}:${secs.toString().padStart(2, "0")} | ${stateEmoji[state.tradingState]} ${state.tradingState} | 💰 $${state.balance.toFixed(2)} | 🎁 ${state.pendingRedeems.length}    `
    );
}

// ============================================
// 🎮 策略核心邏輯
// ============================================
async function processStrategy(prices: { up: number; down: number }, timeRemaining: number) {
    state.lastPrices = prices;
    
    // 🔒 防重入: 如果正在下單中，跳過本次回呼
    if (orderLock) {
        displayStatus(prices, timeRemaining);
        return;
    }
    
    if (state.tradingState === TradingState.SKIPPED || state.tradingState === TradingState.SETTLING) {
        displayStatus(prices, timeRemaining);
        return;
    }
    
    // 持倉監控停損
    if (state.tradingState === TradingState.HOLDING && state.currentPosition) {
        const { side, entryPrice, tokenId, shares } = state.currentPosition;
        const currentPrice = side === "UP" ? prices.up : prices.down;
        const dropPercent = (entryPrice - currentPrice) / entryPrice;
        
        if (timeRemaining <= CONFIG.STOP_LOSS_HOLD_SECONDS) {
            state.stopLossConfirmCount = 0;
            displayStatus(prices, timeRemaining);
            return;
        }
        
        if (dropPercent >= CONFIG.STOP_LOSS_THRESHOLD) {
            state.stopLossConfirmCount++;
            if (state.stopLossConfirmCount >= CONFIG.STOP_LOSS_CONFIRM_COUNT) {
                // 🔒 獲取鎖防止並行重複停損
                orderLock = true;
                
                try {
                    // 先保存數值快照，避免後續變為 null 導致計算 loss 時崩潰
                    const posAmount = state.currentPosition.amount;
                    console.log(`\n🚨 觸發停損條件 (跌幅: ${(dropPercent * 100).toFixed(2)}%)`);
                    
                    const soldSuccess = await executeSellOrder(tokenId, shares);
                    
                    if (soldSuccess) {
                        const loss = posAmount * dropPercent;
                        state.stopLossCount++;
                        state.stopLossTotalAmount += loss;
                        console.log(`   ✅ 停損完成! 損失: -$${loss.toFixed(2)}`);
                    }
                    
                    state.currentPosition = null;
                    state.currentRoundOrder = null;
                    state.stopLossTriggered = true;
                    state.stopLossConfirmCount = 0;
                    state.tradingState = state.rebuyCount >= CONFIG.MAX_REBUY_PER_ROUND 
                        ? TradingState.SKIPPED : TradingState.COOLDOWN;
                } finally {
                    orderLock = false;
                }
            }
        } else {
            state.stopLossConfirmCount = 0;
        }
        
        displayStatus(prices, timeRemaining);
        return;
    }
    
    // 冷卻期重新入場
    if (state.tradingState === TradingState.COOLDOWN) {
        if (timeRemaining > CONFIG.REBUY_WAIT_UNTIL_SECONDS) {
            displayStatus(prices, timeRemaining);
            return;
        }
        
        const higherPrice = Math.max(prices.up, prices.down);
        const higherSide: "UP" | "DOWN" = prices.up >= prices.down ? "UP" : "DOWN";
        
        if (higherPrice >= CONFIG.MIN_REBUY_PROB && cachedTokenIds && state.currentMarket) {
            // 🔒 上鎖 + 先切換狀態，防止並行下單
            orderLock = true;
            state.tradingState = TradingState.ORDERED;
            state.rebuyCount++;
            const tokenId = higherSide === "UP" ? cachedTokenIds.up : cachedTokenIds.down;
            const amount = calculateBetAmount("DEFENSIVE");
            
            try {
                const order = await executeRealOrder(
                    tokenId, higherSide, higherPrice, amount, "DEFENSIVE", timeRemaining, state.currentMarket, 0.15 // 市價單滑點 15%
                );
                
                if (order) {
                    state.currentRoundOrder = order;
                    state.currentPosition = {
                        side: higherSide,
                        entryPrice: higherPrice,
                        amount: order.amount,
                        shares: order.shares,
                        tokenId,
                    };
                    state.tradingState = TradingState.HOLDING;
                }
            } finally {
                orderLock = false;
            }
        }
        
        displayStatus(prices, timeRemaining);
        return;
    }
    
    // 最後決策期
    if (timeRemaining <= CONFIG.MONITORING_END && timeRemaining >= 0) {
        if (state.tradingState !== TradingState.FINAL_DECISION) {
            state.tradingState = TradingState.FINAL_DECISION;
            console.log("\n⚡ 進入最後決策期");
        }
        
        if (!state.finalDecisionMade && timeRemaining <= CONFIG.FINAL_DECISION_TIME && cachedTokenIds && state.currentMarket) {
            // 🔒 上鎖 + 先切換狀態，防止並行下單
            orderLock = true;
            state.finalDecisionMade = true;
            const higherSide: "UP" | "DOWN" = prices.up >= prices.down ? "UP" : "DOWN";
            const higherPrice = Math.max(prices.up, prices.down);
            const tokenId = higherSide === "UP" ? cachedTokenIds.up : cachedTokenIds.down;
            const amount = calculateBetAmount("DEFENSIVE");
            
            console.log(`\n⚡ T-${timeRemaining}s 最後決策: ${higherSide} (${(higherPrice * 100).toFixed(2)}%)`);
            
            // 📝 新增策略邏輯：如果監控期因勝率過高 (≥97%) 被跳過
            // 則只有在最後決策期勝率「跌回 80% 以下」時才允許補單
            if (state.monitoringSkipped && higherPrice >= 0.80) {
                console.log(`   ⏭️ 監控期已跳過且勝率仍高於 80% (${(higherPrice * 100).toFixed(2)}%)，不執行決策下單`);
                orderLock = false;
                state.tradingState = TradingState.HOLDING; // 結束本輪決策
                displayStatus(prices, timeRemaining);
                return;
            }
            
            try {
                const order = await executeRealOrder(
                    tokenId, higherSide, higherPrice, amount, "DEFENSIVE", timeRemaining, state.currentMarket, 0.15 // 市價單滑點 15%
                );
                
                if (order) {
                    state.currentRoundOrder = order;
                    state.currentPosition = {
                        side: higherSide,
                        entryPrice: higherPrice,
                        amount: order.amount,
                        shares: order.shares,
                        tokenId,
                    };
                    state.tradingState = TradingState.HOLDING;
                    console.log(`📊 開始持倉監控`);
                }
            } finally {
                orderLock = false;
            }
        }
        
        displayStatus(prices, timeRemaining);
        return;
    }
    
    // 監控期
    if (timeRemaining <= CONFIG.MONITORING_START && timeRemaining > CONFIG.MONITORING_END) {
        // 如果已經下過單（成功或失敗），不要重設狀態
        if (state.tradingState === TradingState.ORDERED || state.tradingState === TradingState.HOLDING) {
            displayStatus(prices, timeRemaining);
            return;
        }
        
        if (state.tradingState !== TradingState.MONITORING) {
            state.tradingState = TradingState.MONITORING;
            state.consecutiveHighProb = { up: 0, down: 0 };
            console.log("\n👀 進入監控期");
        }
        
        if (prices.up >= CONFIG.HIGH_PROB_THRESHOLD) {
            state.consecutiveHighProb.up++;
            state.consecutiveHighProb.down = 0;
            
            if (state.consecutiveHighProb.up >= CONFIG.CONSECUTIVE_HITS && cachedTokenIds && state.currentMarket) {
                // ⛔ 價格過高 (≥97%) 時跳過下單 — 訂單簿流動性不足會導致 no match
                if (prices.up >= 0.97) {
                    console.log(`\n⚠️ UP ${(prices.up * 100).toFixed(0)}% 過高，跳過下單 (訂單簿無流動性)`);
                    state.monitoringSkipped = true;
                    state.tradingState = TradingState.HOLDING; // 防止重試
                    displayStatus(prices, timeRemaining);
                    return;
                }
                // 🔒 上鎖 + 先切換狀態，防止並行下單
                orderLock = true;
                state.tradingState = TradingState.ORDERED;
                console.log(`\n🎯 UP 連續 ${state.consecutiveHighProb.up} 次達標！`);
                const amount = calculateBetAmount("STANDARD");
                
                try {
                    const order = await executeRealOrder(
                        cachedTokenIds.up, "UP", prices.up, amount, "STANDARD", timeRemaining, state.currentMarket, 0.10 // 市價單滑點 10%
                    );
                    
                    if (order) {
                        state.currentRoundOrder = order;
                        state.currentPosition = {
                            side: "UP",
                            entryPrice: prices.up,
                            amount: order.amount,
                            shares: order.shares,
                            tokenId: cachedTokenIds.up,
                        };
                        state.tradingState = TradingState.HOLDING;
                        console.log(`📊 開始持倉監控`);
                    }
                } finally {
                    orderLock = false;
                }
            }
        } else if (prices.down >= CONFIG.HIGH_PROB_THRESHOLD) {
            state.consecutiveHighProb.down++;
            state.consecutiveHighProb.up = 0;
            
            if (state.consecutiveHighProb.down >= CONFIG.CONSECUTIVE_HITS && cachedTokenIds && state.currentMarket) {
                // ⛔ 價格過高 (≥97%) 時跳過下單 — 訂單簿流動性不足會導致 no match
                if (prices.down >= 0.97) {
                    console.log(`\n⚠️ DOWN ${(prices.down * 100).toFixed(0)}% 過高，跳過下單 (訂單簿無流動性)`);
                    state.monitoringSkipped = true;
                    state.tradingState = TradingState.HOLDING; // 防止重試
                    displayStatus(prices, timeRemaining);
                    return;
                }
                // 🔒 上鎖 + 先切換狀態，防止並行下單
                orderLock = true;
                state.tradingState = TradingState.ORDERED;
                console.log(`\n🎯 DOWN 連續 ${state.consecutiveHighProb.down} 次達標！`);
                const amount = calculateBetAmount("STANDARD");
                
                try {
                    const order = await executeRealOrder(
                        cachedTokenIds.down, "DOWN", prices.down, amount, "STANDARD", timeRemaining, state.currentMarket, 0.10 // 市價單滑點 10%
                    );
                    
                    if (order) {
                        state.currentRoundOrder = order;
                        state.currentPosition = {
                            side: "DOWN",
                            entryPrice: prices.down,
                            amount: order.amount,
                            shares: order.shares,
                            tokenId: cachedTokenIds.down,
                        };
                        state.tradingState = TradingState.HOLDING;
                        console.log(`📊 開始持倉監控`);
                    }
                } finally {
                    orderLock = false;
                }
            }
        } else {
            state.consecutiveHighProb = { up: 0, down: 0 };
        }
        
        displayStatus(prices, timeRemaining);
        return;
    }
    
    // 等待期
    if (state.tradingState !== TradingState.WAITING && timeRemaining > CONFIG.MONITORING_START) {
        state.tradingState = TradingState.WAITING;
    }
    
    displayStatus(prices, timeRemaining);
}

// ============================================
// 🔧 工具函數
// ============================================
function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function getTimeRemaining(market: any): number {
    const endTime = market.endDate || market.end_date_iso;
    if (!endTime) return 999;
    return Math.max(0, Math.floor((new Date(endTime).getTime() - Date.now()) / 1000));
}

// ============================================
// 🚀 主循環
// ============================================
async function runLiveTrading() {
    console.log("\n" + "=".repeat(60));
    console.log("🚀 BTC 5分鐘預測市場正式交易系統");
    console.log("=".repeat(60));
    console.log(`\n⚠️  警告: 此程式使用真實資金交易！`);
    console.log(`   網路: ${CONFIG.IS_MAINNET ? "Polygon 主網" : "Amoy 測試網"}`);
    console.log(`   初始本金: $${state.balance.toFixed(2)}`);
    console.log(`   策略: 高勝率 ${CONFIG.HIGH_PROB_THRESHOLD * 100}% / 連續 ${CONFIG.CONSECUTIVE_HITS} 次`);
    console.log(`   停損: ${CONFIG.STOP_LOSS_THRESHOLD * 100}% (連續 ${CONFIG.STOP_LOSS_CONFIRM_COUNT} 次確認)`);
    console.log("\n按 Ctrl+C 停止\n");
    
    state.isRunning = true;
    let lastRedeemCheck = 0;
    
    const onPriceUpdate = async (prices: { up: number; down: number }) => {
        if (!state.currentMarket) return;
        const timeRemaining = getTimeRemaining(state.currentMarket);
        await processStrategy(prices, timeRemaining);
    };
    
    while (state.isRunning) {
        try {
            const market = await getCurrentBTC5MinMarket();
            
            if (!market) {
                process.stdout.write(`\r⏳ [${new Date().toLocaleTimeString("zh-TW")}] 搜索市場中...                              `);
                await sleep(2000);
                continue;
            }
            
            // 新市場
            if (state.currentMarket?.id !== market.id) {
                // 處理上一輪訂單
                if (state.currentRoundOrder && state.tradingState === TradingState.HOLDING) {
                    state.currentRoundOrder.finalPrices = { ...state.lastPrices };
                    
                    // 加入待領獎列表
                    if (state.currentRoundOrder.conditionId) {
                        state.pendingRedeems.push({
                            conditionId: state.currentRoundOrder.conditionId,
                            marketSlug: state.currentRoundOrder.marketSlug,
                            side: state.currentRoundOrder.side,
                            shares: state.currentRoundOrder.shares,
                            entryPrice: state.currentRoundOrder.price,
                            marketEndTime: new Date(),
                            redeemAttempts: 0,
                        });
                        console.log(`\n📝 訂單加入待領獎列表 (共 ${state.pendingRedeems.length} 筆)`);
                    }
                } else if (state.totalRounds > 0) {
                    state.skipped++;
                    console.log(`\n⏭️ 第 ${state.totalRounds} 輪跳過（無下單）`);
                }
                
                // 重置狀態
                state.totalRounds++;
                state.currentMarket = market;
                state.tradingState = TradingState.WAITING;
                state.currentRoundOrder = null;
                state.consecutiveHighProb = { up: 0, down: 0 };
                state.finalDecisionMade = false;
                state.currentPosition = null;
                state.stopLossTriggered = false;
                state.rebuyCount = 0;
                state.stopLossConfirmCount = 0;
                state.monitoringSkipped = false;
                
                console.log(`\n\n${"=".repeat(50)}`);
                console.log(`📌 第 ${state.totalRounds} 輪 - ${market.question || market.slug}`);
                console.log(`   Condition ID: ${(market.conditionId || market.condition_id || "").slice(0, 20)}...`);
                console.log(`${"=".repeat(50)}`);
                
                const tokenIds = extractTokenIds(market);
                if (tokenIds) {
                    cachedTokenIds = tokenIds;
                    if (market.outcomePrices) {
                        try {
                            const outcomeP = JSON.parse(market.outcomePrices);
                            state.lastPrices = { up: parseFloat(outcomeP[0]), down: parseFloat(outcomeP[1]) };
                        } catch {}
                    }
                    connectPriceWebSocket(tokenIds, onPriceUpdate);
                }
            }
            
            // 定期處理待領獎
            const now = Date.now();
            if (now - lastRedeemCheck > CONFIG.REDEEM_CHECK_INTERVAL) {
                const tr = getTimeRemaining(market);
                // 🛑 避免在緊要關頭（市場最後 40 秒內）執行耗時的領獎與餘額同步 API
                // 這樣能保證監控期 (30s ~ 15s) 與最後決策期的 WebSocket 與下單不會被阻塞
                if (tr > 40 || tr <= 0) {
                    lastRedeemCheck = now;
                    await processPendingRedeems();
                }
            }
            
            const timeRemaining = getTimeRemaining(market);
            if (timeRemaining <= 0) {
                console.log(`\n⏳ 市場已結束，等待下一個...`);
                state.currentMarket = null;
                cachedTokenIds = null;
                if (priceWebSocket) {
                    try { priceWebSocket.close(); } catch {}
                    priceWebSocket = null;
                }
                await sleep(2000);
                continue;
            }
            
            await sleep(CONFIG.MIN_REQUEST_INTERVAL);
            
        } catch (error) {
            console.error("\n❌ 循環錯誤:", error);
            await sleep(2000);
        }
    }
}

// ============================================
// 🚀 啟動
// ============================================
async function main() {
    process.on("SIGINT", async () => {
        console.log("\n\n🛑 停止交易系統...");
        state.isRunning = false;
        
        if (priceWebSocket) {
            try { priceWebSocket.close(); } catch {}
        }
        if (pingInterval) clearInterval(pingInterval);
        
        // 處理剩餘的待領獎
        if (state.pendingRedeems.length > 0) {
            console.log(`\n🎁 處理剩餘 ${state.pendingRedeems.length} 筆待領獎...`);
            for (const item of state.pendingRedeems) {
                await redeemPositions(item.conditionId);
            }
        }
        
        console.log(`\n${"=".repeat(50)}`);
        console.log(`📊 交易統計`);
        console.log(`${"=".repeat(50)}`);
        console.log(`   總輪數: ${state.totalRounds}`);
        console.log(`   勝: ${state.wins} | 負: ${state.losses} | 跳過: ${state.skipped}`);
        console.log(`   停損: ${state.stopLossCount} 次 (-$${state.stopLossTotalAmount.toFixed(2)})`);
        console.log(`   已領獎: ${state.totalRedeemed} 筆`);
        console.log(`   最終餘額: $${state.balance.toFixed(2)}`);
        console.log(`   報酬率: ${(((state.balance - CONFIG.INITIAL_BALANCE) / CONFIG.INITIAL_BALANCE) * 100).toFixed(2)}%`);
        console.log(`${"=".repeat(50)}`);
        
        process.exit(0);
    });
    
    // 初始化
    const initialized = await initializeTradingClient();
    if (!initialized) {
        console.error("❌ 初始化失敗，退出");
        process.exit(1);
    }
    
    const approved = await checkAndSetApprovals();
    if (!approved) {
        console.error("❌ 授權設置失敗，退出");
        process.exit(1);
    }
    
    // 確認執行
    console.log("\n⚠️  即將開始正式交易！");
    console.log("   按 Ctrl+C 取消，或等待 5 秒後自動開始...\n");
    await sleep(5000);
    
    await runLiveTrading();
}

main().catch(console.error);
