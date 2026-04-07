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
} from "@polymarket/clob-client";
import { getContractConfig } from "../lib/config.ts";
import { ctfAbi } from "../lib/abi/ctfAbi.ts";
import { usdcAbi } from "../lib/abi/usdcAbi.ts";
import { logger } from "../lib/logger.ts";
import { sendDiscordNotification } from "./discord-notifier.ts";

dotenvConfig({ path: resolve(import.meta.dirname, "../../.env") });

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
    STANDARD_RATIO: 0.2,                       // 標準倉位比例 (1/5)
    DEFENSIVE_RATIO: 0.1,                      // 防禦倉位比例 (1/10)
    
    // 策略參數
    HIGH_PROB_THRESHOLD: 0.85,                 // 85% 高勝率門檻
    CONSECUTIVE_HITS: 5,                       // 連續達標次數
    
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
    
    // 結算與領獎
    REDEEM_DELAY: 180000,                      // 市場結束後等待多久才領獎 (3分鐘)
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
    orderType: "STANDARD" | "DEFENSIVE";
    timestamp: Date;
    timeRemaining: number;
    status: "PENDING" | "FILLED" | "PARTIAL" | "CANCELLED" | "FAILED";
    finalPrices?: { up: number; down: number };
}

interface PendingRedeem {
    conditionId: string;
    marketSlug: string;
    shares: number;
    marketEndTime: Date;
    redeemAttempts: number;
    lastAttemptTime?: number; // 🆕 追蹤最後嘗試時間以進行退避 (Backoff)
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
    relayerCooldownUntil: number; // 🆕 處理 429 錯誤的冷卻期
    
    // 統計
    totalRounds: number;
    wins: number;
    losses: number;
    skipped: number;
    stopLossCount: number;
    stopLossTotalAmount: number;
    totalRedeemed: number;
    lastHistoryScan: number; // 🆕 紀錄最後一次歷史獎勵掃描的時間
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
    relayerCooldownUntil: 0,
    
    totalRounds: 0,
    wins: 0,
    losses: 0,
    skipped: 0,
    stopLossCount: 0,
    stopLossTotalAmount: 0,
    totalRedeemed: 0,
    lastHistoryScan: 0,
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

logger.info("✅ 正式交易系統模組載入完成");
logger.info(`   網路: ${CONFIG.IS_MAINNET ? "Polygon 主網" : "Amoy 測試網"}`);

// ============================================
// 🔐 初始化交易客戶端
// ============================================
async function initializeTradingClient(): Promise<boolean> {
    logger.info("\n🔐 初始化交易客戶端...");
    
    const privateKey = process.env.PK;
    if (!privateKey) {
        logger.error("❌ 錯誤: 缺少 PK (私鑰) 環境變數");
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
        logger.info(`   錢包地址: ${address}`);
        
        // 判斷簽章類型：有 FUNDER_ADDRESS 表示使用 Polymarket 代理錢包
        const funderAddress = process.env.FUNDER_ADDRESS;
        const sigType = funderAddress ? SignatureType.POLY_GNOSIS_SAFE : SignatureType.EOA;
        
        if (funderAddress) {
            // logger.info(`   代理錢包: ${funderAddress}`);
        }
        
        // 取得或建立 API 憑證
        const tempClient = new ClobClient(CONFIG.CLOB_API_URL, CONFIG.CHAIN_ID, wallet);
        const creds = await tempClient.createOrDeriveApiKey();
        
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
        const balanceResponse: any = await clobClient.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
        if (balanceResponse && typeof balanceResponse.balance !== "undefined") {
            balanceFormatted = parseFloat(balanceResponse.balance) / 1e6;
        } else {
            logger.warn("   ⚠️ 無法從 API 取得餘額，回傳格式:", balanceResponse);
        }
        logger.info(`   USDC 餘額: $${balanceFormatted.toFixed(2)}`);
        
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
                    logger.info(`   RPC 連接成功: ${url} (用於 Redeem)`);
                    break;
                } catch {
                    // 繼續嘗試下一個
                }
            }
            if (!ctfContract) {
                logger.info("   ⚠️ 所有 RPC 節點都無法連接，Redeem 功能將無法使用（不影響下單）");
            }
        } catch {
            logger.info("   ⚠️ RPC 連接失敗，Redeem 功能將無法使用（不影響下單）");
        }
        
        // 初始化 Relayer 客戶端 (用於代理錢包領獎 / Gasless)
        if (funderAddress) {
            try {
                logger.info(`   🔧 初始化 Relayer 客戶端 (用於 Safe 領獎)...`);
                
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
                    logger.info(`      使用 .env 中的 Builder 金鑰進行授權...`);
                    builderConfig = new BuilderConfig({
                        localBuilderCreds: {
                            key: bKey,
                            secret: bSecret,
                            passphrase: bPass
                        }
                    });
                } else {
                    logger.info(`      ⚠️ .env 未發現 Builder 金鑰，嘗試自動衍生以避免 401 錯誤...`);
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
                        logger.info(`      ✅ 已自動衍生 Builder 認證`);
                    } catch (err: any) {
                        logger.warn(`      ❌ 自動衍生 Builder 金鑰失敗: ${err.message}`);
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
                logger.info(`   ✅ Relayer 客戶端初始化成功`);
            } catch (err: any) {
                logger.warn(`   ⚠️ Relayer 客戶端初始化失敗: ${err.message}`);
                logger.warn(`   ℹ️ 領獎功能將無法使用，請至網頁手動操作`);
            }
        }
        
        logger.info("✅ 交易客戶端初始化完成\n");
        sendDiscordNotification(`🚀 BTC 正式交易系統已啟動\n💰 錢包餘額: $${state.balance.toFixed(2)} USDC\n🌐 網路: ${CONFIG.IS_MAINNET ? "Polygon 主網" : "Amoy 測試網"}`);
        return true;
        
    } catch (error) {
        logger.error({ error }, "❌ 初始化失敗:");
        return false;
    }
}

// ============================================
// ✅ 檢查並設置授權
// ============================================
async function checkAndSetApprovals(): Promise<boolean> {
    if (!wallet || !usdcContract || !ctfContract) {
        logger.info("🔑 合約授權檢查...");
        logger.info("   ⚠️ 合約未初始化（RPC 未連接），跳過授權步驟");
        logger.info("   ℹ️ 下單與停損透過 Polymarket API 執行，不需要鏈上授權");
        logger.info("   ℹ️ 唯有 Redeem 領獎才需要鏈上授權（可在網頁手動操作）\n");
        return true;
    }
    
    logger.info("🔑 檢查合約授權...");
    
    // 💡 代理錢包 (Proxy Wallet) 處理：
    // 如果使用代理錢包，USDC 授權是由代理錢包合約處理的，通常由 API 自動完成。
    // 手動執行 EOA 的 approve 是多餘且容易報錯的（因為 EOA 可能沒有 USDC）。
    if (process.env.FUNDER_ADDRESS) {
        logger.info("   ℹ️ 偵測到代理錢包，授權由 Polymarket 自動處理，跳過手動步驟");
        logger.info("   ✅ 錢包檢查完成\n");
        return true;
    }
    
    try {
        const address = await wallet.getAddress();
        
        // 🔍 先檢查 MATIC 餘額
        const maticBalance = await wallet.getBalance();
        const maticFormatted = parseFloat(ethers.utils.formatEther(maticBalance));
        logger.info(`   MATIC 餘額: ${maticFormatted.toFixed(6)} MATIC`);
        
        if (maticFormatted < 0.001) {
            logger.warn(`\n   ⚠️ MATIC 餘額不足，跳過鏈上授權步驟`);
            logger.warn(`   💡 請轉入約 0.5~1 MATIC 到 ${address} 以啟用自動領獎\n`);
            return true;
        }
        
        const contractConfig = getContractConfig(CONFIG.CHAIN_ID);
        
        // 檢查 USDC 對 Exchange 的授權
        const usdcAllowance = await usdcContract.allowance(address, contractConfig.exchange);
        if (usdcAllowance.eq(0)) {
            logger.info("   設定 USDC → Exchange 授權...");
            // 取得 pending nonce 以避免跟交易池中的交易衝突
            const nonce = await wallet!.getTransactionCount("pending");
            logger.info(`   使用 nonce: ${nonce}`);
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
            logger.info(`   ⏳ 等待授權確認...`);
            await tx.wait();
            logger.info(`   ✅ 授權完成: ${tx.hash}`);
        } else {
            logger.info("   ✅ USDC → Exchange 已授權");
        }
        
        // 檢查 CTF 對 Exchange 的授權
        const ctfApproved = await ctfContract.isApprovedForAll(address, contractConfig.exchange);
        if (!ctfApproved) {
            logger.info("   設定 CTF → Exchange 授權...");
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
            logger.info(`   ⏳ 等待授權確認...`);
            await tx.wait();
            logger.info(`   ✅ 授權完成: ${tx.hash}`);
        } else {
            logger.info("   ✅ CTF → Exchange 已授權");
        }
        
        logger.info("✅ 授權檢查完成\n");
        return true;
        
    } catch (error: any) {
        if (error.message?.includes("underpriced") || error.message?.includes("fee too low")) {
            logger.error("❌ 授權設置失敗: 交易池中已有相同 Nonce 且 Gas 較高的交易");
            logger.error("   💡 建議: 請稍候再試，或手動在 PolygonScan 檢查是否有卡住的交易");
        } else {
            logger.error("❌ 授權設置失敗:", error.message || error);
        }
        logger.warn("   ℹ️ 繼續執行下單邏輯（下單不需要鏈上授權）\n");
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
    if (!clobClient || !state.isRunning) {
        if (!state.isRunning) {
            logger.warn("   🚫 系統停止中，攔截下單請求");
        } else {
            logger.error("   ❌ CLOB 客戶端未初始化");
        }
        return null;
    }
    
    try {
        logger.info(`\n🚀 執行真實下單 [${orderType}]`);
        logger.info(`   方向: ${side} (${outcomeLabels[side.toLowerCase() as "up" | "down"]})`);
        logger.info(`   價格: ${(price * 100).toFixed(2)}% | 金額: $${amount.toFixed(2)}`);
        
        // 獲取市場參數
        const tickSize = market.minimum_tick_size || "0.01";
        const negRisk = market.neg_risk || false;
        
        const cappedPrice = Math.min(0.99, price + slippage);
        
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
            logger.error(`   ❌ 下單失敗: ${errorMsg}`);
            return null;
        }
        
        const orderId = response.orderID || response.id || `ORD-${Date.now()}`;
        logger.info({ orderId, side, price, amount }, `   ✅ 下單成功! 訂單 ID: ${orderId.slice(0, 15)}...`);
        sendDiscordNotification(`🎯 【下單成功】\nside: "${side}"\nprice: ${price.toFixed(4)}\n投入金額: ${amount.toFixed(2)}\n當前錢包金額: ${state.balance.toFixed(2)}`);
        
        // 🛠️ 優化：從 API 回應獲取「實時成交股數」而非本地計算
        let actualShares = 0;
        if (response.takingAmount) {
            const takingNum = parseFloat(response.takingAmount);
            if (!isNaN(takingNum) && takingNum > 0) {
                actualShares = takingNum;
            }
        }
        
        if (actualShares === 0) {
            actualShares = Math.floor((amount / price) * 100) / 100;
        }

        logger.info(`   📊 成交股數: ${actualShares.toFixed(2)}`);
        logger.info(`${"=".repeat(50)}\n`);
        
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
            shares: actualShares,
            orderType,
            timestamp: new Date(),
            timeRemaining,
            status: "FILLED",
        };
        
        return order;
        
    } catch (error) {
        logger.error({ error }, `❌ 下單錯誤:`);
        return null;
    }
}

// ============================================
// 📤 停損賣出
// ============================================
async function executeSellOrder(tokenId: string, shares: number, currentPrice: number): Promise<boolean> {
    if (!clobClient) return false;
    
    // 🔍 獲取該市場的精確 tickSize (通常 0.01)
    let tickSize = "0.01";
    try {
        const info = await clobClient.getTickSize(tokenId);
        if (info) tickSize = info.toString();
    } catch {}

    const maxRetries = 3;
    let attempt = 0;
    
    while (attempt < maxRetries) {
        attempt++;
        try {
            if (attempt > 1) {
                logger.info(`   ⏳ 正在重試賣出 (${attempt}/${maxRetries})...`);
                await sleep(500); // 每次重試等待 500ms
            } else {
                logger.info(`\n🔻 執行停損賣出: ${shares.toFixed(6)} 股`);
            }
            
            // 🚀 修正：賣出前獲取真實代幣餘額，防止因手續費導致的「餘額不足」錯誤
            let finalShares = shares;
            if (clobClient) {
                try {
                    const balanceRes: any = await clobClient.getBalanceAllowance({
                        asset_type: AssetType.CONDITIONAL,
                        token_id: tokenId
                    });
                    if (balanceRes && typeof balanceRes.balance !== "undefined") {
                        let realBalance = parseFloat(balanceRes.balance) / 1e6;
                        
                        // 🆕 處理同步延遲：如果原本有倉位但查詢為 0，進行重試
                        if (realBalance === 0 && shares > 0 && attempt < maxRetries) {
                            logger.warn(`   ⚠️ 餘額顯示為 0，但在本地記錄中有持倉，正在等待同步...`);
                            await sleep(1000); // 等待 1 秒
                            // 再次獲取
                            const secondTry: any = await clobClient.getBalanceAllowance({
                                asset_type: AssetType.CONDITIONAL,
                                token_id: tokenId
                            });
                            if (secondTry && typeof secondTry.balance !== "undefined") {
                                realBalance = parseFloat(secondTry.balance) / 1e6;
                            }
                        }

                        if (realBalance < shares) {
                            logger.info(`   📝 餘額修正: 預計 ${shares.toFixed(6)} -> 實際 ${realBalance.toFixed(6)} (補償手續費)`);
                            finalShares = realBalance;
                        }
                    }
                } catch (e) {
                    logger.warn(`   ⚠️ 無法獲取實時餘額，將嘗試以原始股數賣出`);
                }
            }

            if (finalShares <= 0) {
                logger.info(`   ℹ️ 檢測到餘額為 0，視為已賣出或未成交`);
                return true; 
            }

            // Polymarket FAK 訂單在此模式下等同於 Market Sell
            const response = await clobClient!.createAndPostMarketOrder(
                {
                    tokenID: tokenId,
                    amount: finalShares,
                    side: Side.SELL,
                    orderType: OrderType.FAK,
                    price: 0.01, // 極低限價 = 市價單
                },
                { tickSize: tickSize as any }
            );
            
            if (response.success === false || response.error) {
                const errorMsg = response.errorMsg || response.error || "";
                
                // 如果是餘額不足，且還有重試機會，執行重試
                if ((errorMsg.includes("balance") || errorMsg.includes("allowance")) && attempt < maxRetries) {
                    logger.warn(`   ⚠️ 餘額尚未同步 (balance: 0)，結算延遲中...`);
                    continue;
                }
                
                logger.error({ errorMsg, tokenId, shares }, `   ❌ 賣出失敗: ${errorMsg}`);
                return false;
            }
            
            logger.info({ tokenId, shares }, `   ✅ 停損賣出成功 (訂單 ID: ${(response.orderID || response.id).slice(0, 10)}...)`);
            sendDiscordNotification(`🔻 【停損成功】\n停損金額: ${currentPrice.toFixed(4)}\n當前錢包金額: ${state.balance.toFixed(2)}`);
            
            // 📊 統計：停損視為一場虧損
            state.losses++;
            state.stopLossCount++;
            if (state.currentPosition) {
                const estLoss = (state.currentPosition.entryPrice - 0.01) * shares; 
                state.stopLossTotalAmount += Math.max(0, estLoss);
            }
            
            return true;
            
        } catch (error: any) {
            logger.error({ err: error }, `   ❌ 停損賣出錯誤 (嘗試 ${attempt}):`);
            if (attempt >= maxRetries) return false;
        }
    }
    
    return false;
}

// ============================================
// 🎁 領取獎勵 (Redeem) - 支援 Safe 代理錢包
// ============================================

async function redeemPositions(conditionId: string, shares: number = 0, marketSlug: string = "unknown", attempt: number = 1): Promise<boolean> {
    const contractConfig = getContractConfig(CONFIG.CHAIN_ID);

    // --------------------------------------------
    // 優先模式: Relayer (Gasless / Safe 錢包首選)
    // --------------------------------------------
    if (relayClient) {
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
            
            logger.info(`   ⏳ 發送 Relayer 交易...`);
            const response = await withTimeout(
                relayClient.execute([redeemTx], `redeem ${conditionId.slice(0, 10)}`),
                20000, // 20 秒提交超時
                "Relayer 提交響應過慢"
            );
            
            const result = await withTimeout(
                response.wait(),
                30000, 
                "鏈上確認超時"
            );
            
            if (result && result.transactionHash) {
                logger.info(`   ✅ 領取成功 (Hash: ${result.transactionHash.slice(0, 8)}...)`);
                sendDiscordNotification(`🎁 【領獎成功】\n領獎金額: ${shares.toFixed(2)}\n當前錢包金額: ${state.balance.toFixed(2)}`);
                state.totalRedeemed++;
                return true;
            }
        } catch (error: any) {
            const errMsg = error.message || JSON.stringify(error);
            const status = error.response?.status || error.status;

            // 🆕 429 Too Many Requests 處理
            if (status === 429 || errMsg.includes("429") || errMsg.includes("quota exceeded")) {
                logger.warn(`\n⚠️ Relayer 配額耗盡 (429)，暫停領獎任務 5 分鐘...`);
                state.relayerCooldownUntil = Date.now() + (5 * 60 * 1000);
                return false;
            }

            if (errMsg.includes("revert") || errMsg.includes("insufficient") || errMsg.includes("execution reverted")) {
                logger.info(`   ℹ️ 無可領取餘額 (已領取或該方未獲勝)`);
                return true;
            }
            if (errMsg.includes("TIMEOUT")) {
                // logger.warn(`   ⚠️ 領取超時 (可能仍在處理中)，將在稍後自動重試`);
            } else {
                logger.error(`   ❌ 領取失敗: ${errMsg.slice(0, 50)}...`);
            }
        }
    }
    
    // --------------------------------------------
    // 備用模式: EOA 直接呼叫
    // --------------------------------------------
    if (ctfContract && wallet) {
        try {
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
            
            const receipt = await tx.wait();
            if (receipt.status === 1) {
                logger.info(`   ✅ 領取成功 (EOA)`);
                state.totalRedeemed++;
                return true;
            }
        } catch (error: any) {
            const errMsg = error.message || "";
            if (errMsg.includes("revert") || errMsg.includes("insufficient")) {
                logger.info(`   ℹ️ 無可領取餘額`);
                return true;
            }
        }
    }

    return false;
}

// ============================================
// 🔄 處理待領獎項目
// ============================================
async function processPendingRedeems(): Promise<void> {
    if (state.pendingRedeems.length === 0) return;
    
    const now = Date.now();
    
    // 🛑 檢查冷卻期 (429)
    if (now < state.relayerCooldownUntil) {
        return;
    }

    const toRemove: number[] = [];
    
    // 🛡️ 修正：按照用戶要求，最大重試次數改為 3 次
    const MAX_ATTEMPTS = 3;

    for (let i = 0; i < state.pendingRedeems.length; i++) {
        const item = state.pendingRedeems[i];
        
        // 🆕 持久化退避邏輯 (Exponential Backoff Idea)
        // 第一次待 4 分鐘，第二次失敗後待 5 分鐘，第三次帶 10 分鐘，以此類推
        // 第 N 次間隔 = REDEEM_DELAY + (attempts * 5 分鐘)
        const backoffMs = item.redeemAttempts * (5 * 60 * 1000); 
        const nextAllowedTime = (item.lastAttemptTime || item.marketEndTime.getTime()) + (item.redeemAttempts === 0 ? CONFIG.REDEEM_DELAY : backoffMs);
        
        if (now < nextAllowedTime) {
            continue;
        }
        
        logger.info(`\n🎁 [${item.marketSlug}] 正在領取 (第 ${item.redeemAttempts + 1} 次)...`);
        
        item.lastAttemptTime = now;
        const success = await redeemPositions(item.conditionId, item.shares, item.marketSlug, item.redeemAttempts + 1);
        
        if (success) {
            toRemove.push(i);
        } else {
            item.redeemAttempts++;
            if (item.redeemAttempts >= MAX_ATTEMPTS) {
                logger.info(`   ⚠️ [${item.marketSlug}] 已嘗試 ${MAX_ATTEMPTS} 次仍失敗，放棄任務`);
                toRemove.push(i);
            } else {
                const nextWaitMins = Math.floor((item.redeemAttempts * 5 * 60 * 1000) / 60000);
                logger.info(`   ⚠️ 領取暫時失敗，將在 ${nextWaitMins || 2} 分鐘後重試`);
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
// 🔍 掃描並加入歷史未領取獎勵
// ============================================
async function scanAndAddOldRedeems(): Promise<void> {
    if (!clobClient) return;
    
    // 取得錢包地址 (優先使用代理錢包)
    const funderAddress = process.env.FUNDER_ADDRESS;
    const userAddress = funderAddress || await wallet?.getAddress();
    
    if (!userAddress) return;
    
    logger.info(`\n🔍 啟動自動掃描: 正在檢查錢包中的歷史未領取獎勵...`);
    try {
        const DATA_API_URL = "https://data-api.polymarket.com";
        const resp = await fetch(`${DATA_API_URL}/positions?user=${userAddress}`);
        const positions: any[] = await resp.json();
        
        // 過濾出已結算且獲勝的持倉 (curPrice === 1)
        const rewards = positions.filter(p => p.size > 0 && p.curPrice === 1);
        
        if (rewards.length === 0) {
            logger.info(`   ℹ️ 未發現任何歷史未領取獎勵。`);
            return;
        }
        
        logger.info(`   ✨ 發現 ${rewards.length} 筆歷史未領取獎勵！已加入待領排程。`);
        for (const r of rewards) {
            // 檢查是否已經在排程中，避免重複加入
            const exists = state.pendingRedeems.some(p => p.conditionId === r.conditionId);
            if (!exists) {
                state.pendingRedeems.push({
                    conditionId: r.conditionId,
                    marketSlug: r.asset || "Historical Market",
                    shares: parseFloat(r.size),
                    marketEndTime: new Date(), // 設定為已結束
                    redeemAttempts: 0,
                });
            }
        }
    } catch (error) {
        logger.error({ error }, "   ❌ 自動掃描失敗:");
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
                logger.info(`\n💰 餘額已更新: $${state.balance.toFixed(2)} → $${newBalance.toFixed(2)}`);
                state.balance = newBalance;
            }
        }
    } catch (error) {
        logger.error({ error }, "❌ 同步餘額失敗:");
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
        logger.info(`📡 連接 WebSocket: ${wsUrl}`);
    }
    
    const ws = new WebSocket(wsUrl);
    priceWebSocket = ws;
    
    ws.on("open", () => {
        if (wsConnectionId !== thisConnectionId) return;
        if (!isReconnect) logger.info("✅ WebSocket 連接成功");
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
            // 🆕 避讓機制：如果現在距離市場結束不到 5 秒 (關鍵決策期)，則暫不執行網路重連
            // 避免重連開銷影響下單執行
            const currentMarket = state.currentMarket;
            if (currentMarket) {
                const tr = getTimeRemaining(currentMarket);
                if (tr <= 5 && tr > 0) {
                    // logger.info("   🚫 關鍵決策期禁用重連以優化下單延遲");
                    return;
                }
            }
            
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
        logger.error({ error }, "❌ 獲取市場失敗:");
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
    const ratio = orderType === "STANDARD" ? CONFIG.STANDARD_RATIO : CONFIG.DEFENSIVE_RATIO;
    const amount = state.balance * ratio;
    
    // 🛡️ 安全保護：最小開單金額為 $1 USDC
    return Math.max(1, Math.floor(amount * 100) / 100);
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
    if (!state.isRunning) return;
    
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
        
        if (dropPercent >= CONFIG.STOP_LOSS_THRESHOLD) {
            state.stopLossConfirmCount++;
            if (state.stopLossConfirmCount >= CONFIG.STOP_LOSS_CONFIRM_COUNT) {
                // 🔒 獲取鎖防止並行重複停損
                orderLock = true;
                
                try {
                    // 先保存數值快照，避免後續變為 null 導致計算 loss 時崩潰
                    const posAmount = state.currentPosition.amount;
                    logger.info(`\n🚨 觸發停損條件 (跌幅: ${(dropPercent * 100).toFixed(2)}%)`);
                    
                    const soldSuccess = await executeSellOrder(tokenId, shares, currentPrice);
                    
                    if (soldSuccess) {
                        const loss = posAmount * dropPercent;
                        state.stopLossCount++;
                        state.stopLossTotalAmount += loss;
                        logger.info(`   ✅ 停損完成! 損失: -$${loss.toFixed(2)}`);
                    }
                    
                    state.currentPosition = null;
                    state.currentRoundOrder = null;
                    state.stopLossTriggered = true;
                    state.stopLossConfirmCount = 0;
                    
                    // 🛡️ 依照用戶要求：不論賣出成功與否，都進入冷卻期以評估是否需要購買反向倉位
                    if (!soldSuccess) {
                        logger.warn(`\n⚠️ 停損賣出未完全成功，但仍繼續監控反向機會...`);
                    }
                    
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
                    state.finalDecisionMade = true; // 🆕 標記決策已完成，防止最後幾秒重複下單
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
            logger.info("\n⚡ 進入最後決策期");
        }
        
        // 🆕 修正：如果已經有持倉（不論是剛下的還是追單下的），就不進度最後決策下單
        if (state.currentPosition) {
            displayStatus(prices, timeRemaining);
            return;
        }

        if (!state.finalDecisionMade && timeRemaining <= CONFIG.FINAL_DECISION_TIME && cachedTokenIds && state.currentMarket) {
            // 🔒 上鎖 + 先切換狀態，防止並行下單
            orderLock = true;
            state.finalDecisionMade = true;
            const higherSide: "UP" | "DOWN" = prices.up >= prices.down ? "UP" : "DOWN";
            const higherPrice = Math.max(prices.up, prices.down);
            const tokenId = higherSide === "UP" ? cachedTokenIds.up : cachedTokenIds.down;
            const amount = calculateBetAmount("DEFENSIVE");
            
            logger.info(`\n⚡ T-${timeRemaining}s 最後決策: ${higherSide} (${(higherPrice * 100).toFixed(2)}%)`);
            
            // 📝 新增策略邏輯：如果監控期因勝率過高 (≥97%) 被跳過
            // 則只有在最後決策期勝率「跌回 80% 以下」時才允許補單
            if (state.monitoringSkipped && higherPrice >= 0.80) {
                logger.info(`   ⏭️ 監控期已跳過且勝率仍高於 80% (${(higherPrice * 100).toFixed(2)}%)，不執行決策下單`);
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
                    logger.info(`📊 開始持倉監控`);
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
        if (state.currentPosition) {
            displayStatus(prices, timeRemaining);
            return;
        }
        
        // 如果已經下過單（成功或失敗），不要重設狀態
        if (state.tradingState === TradingState.ORDERED || state.tradingState === TradingState.HOLDING) {
            displayStatus(prices, timeRemaining);
            return;
        }
        
        if (state.tradingState !== TradingState.MONITORING) {
            state.tradingState = TradingState.MONITORING;
            state.consecutiveHighProb = { up: 0, down: 0 };
            logger.info("\n👀 進入監控期");
        }
        
        if (prices.up >= CONFIG.HIGH_PROB_THRESHOLD) {
            state.consecutiveHighProb.up++;
            state.consecutiveHighProb.down = 0;
            
            if (state.consecutiveHighProb.up >= CONFIG.CONSECUTIVE_HITS && cachedTokenIds && state.currentMarket) {
                // ⛔ 價格過高 (≥99%) 時跳過下單 — 訂單簿流動性不足會導致 no match
                if (prices.up >= 0.99) {
                    logger.info(`\n⚠️ UP ${(prices.up * 100).toFixed(0)}% 過高，跳過下單 (訂單簿無流動性)`);
                    state.monitoringSkipped = true;
                    state.tradingState = TradingState.HOLDING; // 防止重試
                    displayStatus(prices, timeRemaining);
                    return;
                }
                // 🔒 上鎖 + 先切換狀態，防止並行下單
                orderLock = true;
                state.tradingState = TradingState.ORDERED;
                logger.info(`\n🎯 UP 連續 ${state.consecutiveHighProb.up} 次達標！`);
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
                        logger.info(`📊 開始持倉監控`);
                    }
                } finally {
                    orderLock = false;
                }
            }
        } else if (prices.down >= CONFIG.HIGH_PROB_THRESHOLD) {
            state.consecutiveHighProb.down++;
            state.consecutiveHighProb.up = 0;
            
            if (state.consecutiveHighProb.down >= CONFIG.CONSECUTIVE_HITS && cachedTokenIds && state.currentMarket) {
                // ⛔ 價格過高 (≥99%) 時跳過下單 — 訂單簿流動性不足會導致 no match
                if (prices.down >= 0.99) {
                    logger.info(`\n⚠️ DOWN ${(prices.down * 100).toFixed(0)}% 過高，跳過下單 (訂單簿無流動性)`);
                    state.monitoringSkipped = true;
                    state.tradingState = TradingState.HOLDING; // 防止重試
                    displayStatus(prices, timeRemaining);
                    return;
                }
                // 🔒 上鎖 + 先切換狀態，防止並行下單
                orderLock = true;
                state.tradingState = TradingState.ORDERED;
                logger.info(`\n🎯 DOWN 連續 ${state.consecutiveHighProb.down} 次達標！`);
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
                        logger.info(`📊 開始持倉監控`);
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

// ⏳ 超時保護包裝器
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, errorMessage: string): Promise<T> {
    let timeoutId: NodeJS.Timeout;
    const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
            reject(new Error(`TIMEOUT: ${errorMessage}`));
        }, timeoutMs);
    });

    try {
        return await Promise.race([promise, timeoutPromise]);
    } finally {
        // @ts-ignore
        clearTimeout(timeoutId);
    }
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
    logger.info("\n" + "=".repeat(60));
    logger.info("🚀 BTC 5分鐘預測市場正式交易系統");
    logger.info("=".repeat(60));
    logger.info(`\n⚠️  警告: 此程式使用真實資金交易！`);
    logger.info(`   網路: ${CONFIG.IS_MAINNET ? "Polygon 主網" : "Amoy 測試網"}`);
    logger.info(`   初始本金: $${state.balance.toFixed(2)}`);
    logger.info(`   策略: 高勝率 ${CONFIG.HIGH_PROB_THRESHOLD * 100}% / 連續 ${CONFIG.CONSECUTIVE_HITS} 次`);
    logger.info(`   停損: ${CONFIG.STOP_LOSS_THRESHOLD * 100}% (連續 ${CONFIG.STOP_LOSS_CONFIRM_COUNT} 次確認)`);
    logger.info("\n按 Ctrl+C 停止\n");
    
    state.isRunning = true;
    let lastRedeemCheck = 0;
    
    const onPriceUpdate = async (prices: { up: number; down: number }) => {
        if (!state.isRunning || !state.currentMarket) return;
        const timeRemaining = getTimeRemaining(state.currentMarket);
        await processStrategy(prices, timeRemaining);
    };
    
    while (state.isRunning) {
        try {
            // ============================================
            // 🎁 定期處理待領獎 & 餘額同步 (搬移至此以確保即使在搜索市場時也能執行)
            // ============================================
            const now = Date.now();
            if (now - lastRedeemCheck > CONFIG.REDEEM_CHECK_INTERVAL) {
                // 🛑 只有當不在關鍵交易期（最後 40 秒）才執行 API 呼叫，避免阻塞 WebSocket 回呼
                // 如果當前沒有市場資訊，視為安全期
                let canRedeem = true;
                if (state.currentMarket) {
                    const tr = getTimeRemaining(state.currentMarket);
                    if (tr <= 40 && tr > 0) canRedeem = false;
                }

                if (canRedeem) {
                    lastRedeemCheck = now;
                    // 同時更新：每小時啟動一次歷史獎勵掃描 (1000 * 60 * 60 = 3600000)
                    if (!state.lastHistoryScan || now - state.lastHistoryScan > 3600000) {
                        state.lastHistoryScan = now;
                        await scanAndAddOldRedeems();
                    }
                    await processPendingRedeems();
                }
            }

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
                    
                    // 📊 判定勝負 (基於最後捕捉到的價格)
                    const upP = state.lastPrices.up;
                    const downP = state.lastPrices.down;
                    const side = state.currentRoundOrder.side;
                    
                    const isWin = (side === "UP" && upP > downP) || (side === "DOWN" && downP > upP);
                    if (isWin) {
                        state.wins++;
                    } else {
                        state.losses++;
                    }
                    
                    // 發送結算通知
                    const winLossStr = isWin ? "✅ 獲勝 (WIN)" : "❌ 失敗 (LOSS)";
                    sendDiscordNotification(`📊 【輪次結算】\n市場: ${state.currentRoundOrder.marketSlug}\n結果: ${winLossStr}\n目前勝場: ${state.wins} | 敗場: ${state.losses}\n錢包餘額: $${state.balance.toFixed(2)} USDC`);
                    
                    // 加入待領獎列表
                    if (state.currentRoundOrder.conditionId) {
                        state.pendingRedeems.push({
                            conditionId: state.currentRoundOrder.conditionId,
                            marketSlug: state.currentRoundOrder.marketSlug,
                            shares: state.currentRoundOrder.shares,
                            marketEndTime: new Date(), // 現在即結束
                            redeemAttempts: 0,
                        });
                        logger.info({ conditionId: state.currentRoundOrder.conditionId }, `\n📝 訂單加入待領獎列表 (共 ${state.pendingRedeems.length} 筆)`);
                    }
                } else if (state.totalRounds > 1) { // 第一輪(剛啟動)若沒下單不計入跳過
                    state.skipped++;
                    logger.info(`\n⏭️ 第 ${state.totalRounds} 輪跳過（無下單）`);
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
                
                logger.info(`\n\n${"=".repeat(50)}`);
                logger.info(`📌 第 ${state.totalRounds} 輪 - ${market.question || market.slug}`);
                logger.info(`   Condition ID: ${(market.conditionId || market.condition_id || "").slice(0, 20)}...`);
                logger.info(`${"=".repeat(50)}`);
                
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
            
            // ============================================
            // 📊 檢查市場結束
            // ============================================
            
            const timeRemaining = getTimeRemaining(market);
            if (timeRemaining <= 0) {
                logger.info(`\n⏳ 市場已結束，等待下一個...`);
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
            logger.error({ error }, "\n❌ 循環錯誤:");
            await sleep(2000);
        }
    }
}

// ============================================
// 🚀 啟動
// ============================================
async function main() {
    process.on("SIGINT", async () => {
        logger.info("\n\n🛑 停止交易系統...");
        state.isRunning = false;
        
        // 立即關閉 WebSocket 以防止新的 price 回調
        if (priceWebSocket) {
            try { 
                priceWebSocket.removeAllListeners();
                priceWebSocket.close(); 
            } catch {}
        }
        if (pingInterval) clearInterval(pingInterval);
        
        // 依照用戶要求：直接停止，不處理剩餘領獎
        if (state.pendingRedeems.length > 0) {
            logger.info(`\nℹ️ 尚有 ${state.pendingRedeems.length} 筆待領獎項目未處理，請手動領取或下次啟動時自動掃描。`);
        }
        
        logger.info(`\n${"=".repeat(50)}`);
        logger.info(`📊 交易統計 (本次運行)`);
        logger.info(`${"=".repeat(50)}`);
        logger.info(`   總輪數: ${state.totalRounds}`);
        logger.info(`   勝: ${state.wins} | 負: ${state.losses} | 跳過: ${state.skipped}`);
        logger.info(`   停損: ${state.stopLossCount} 次 (-$${state.stopLossTotalAmount.toFixed(2)})`);
        logger.info(`   已領獎: ${state.totalRedeemed} 筆`);
        
        // 🆕 計算預估總資產 (錢包 + 待領獎)
        const pendingValue = state.pendingRedeems.reduce((acc, p) => acc + (p.shares * 1.0), 0); 
        const totalEstimated = state.balance + pendingValue;
        
        logger.info(`   錢包餘額: $${state.balance.toFixed(2)}`);
        logger.info(`   預估總額: $${totalEstimated.toFixed(2)} (含待領獎)`);
        logger.info(`${"=".repeat(50)}`);
        
        // 🆕 發送停止通知
        sendDiscordNotification(`🛑 【交易停止】\n原因: 使用者手動關閉 (SIGINT)\n最終餘額: $${state.balance.toFixed(2)}\n預估總額: $${totalEstimated.toFixed(2)}`);
        
        process.exit(0);
    });

    
    // 初始化
    const initialized = await initializeTradingClient();
    if (!initialized) {
        logger.error("❌ 初始化失敗，退出");
        process.exit(1);
    }
    
    const approved = await checkAndSetApprovals();
    if (!approved) {
        logger.error("❌ 授權設置失敗，退出");
        process.exit(1);
    }
    
    // 🔍 啟動自動掃描歷史獎勵
    await scanAndAddOldRedeems();
    
    await runLiveTrading();
}

main().catch((err) => logger.error({ error: err.message, stack: err.stack }, "Fatal Error"));
