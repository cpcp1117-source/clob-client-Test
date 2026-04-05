/**
 * 🧪 環境配置測試腳本
 * 
 * 測試 .env 配置是否正確，並驗證完整交易流程
 * 
 * 測試項目:
 * 1. 錢包連接
 * 2. RPC 連接
 * 3. API 憑證
 * 4. 合約連接
 * 5. 餘額檢查
 * 6. 授權檢查
 * 7. (可選) 小額測試交易
 */

import { config as dotenvConfig } from "dotenv";
import { resolve } from "path";
import { ethers, constants } from "ethers";
import { 
    ClobClient, 
    Side, 
    OrderType, 
    AssetType,
    Chain 
} from "../src/index.ts";
import { getContractConfig } from "../src/config.ts";
import { ctfAbi } from "../examples/abi/ctfAbi.ts";
import { usdcAbi } from "../examples/abi/usdcAbi.ts";

dotenvConfig({ path: resolve(import.meta.dirname, "../.env") });

// ============================================
// 🎛️ 測試配置
// ============================================
const TEST_CONFIG = {
    // 是否執行真實交易測試（會花費少量 USDC 和 Gas）
    EXECUTE_REAL_TRADE: false,          // ⚠️ 設為 true 執行真實交易測試
    TEST_TRADE_AMOUNT: 0.10,            // 測試交易金額 $0.10 USDC
    
    // 網路設定
    IS_MAINNET: true,
    CHAIN_ID: 137 as Chain,
    
    // RPC (可更換為你的 Alchemy/Infura URL)
    RPC_URL: process.env.RPC_URL || "https://polygon-rpc.com",
    
    // API
    CLOB_API_URL: process.env.CLOB_API_URL || "https://clob.polymarket.com",
    GAMMA_API_URL: "https://gamma-api.polymarket.com",
};

// ============================================
// 🎨 輸出工具
// ============================================
const log = {
    title: (msg: string) => console.log(`\n${"=".repeat(50)}\n${msg}\n${"=".repeat(50)}`),
    step: (num: number, msg: string) => console.log(`\n📌 步驟 ${num}: ${msg}`),
    success: (msg: string) => console.log(`   ✅ ${msg}`),
    error: (msg: string) => console.log(`   ❌ ${msg}`),
    warn: (msg: string) => console.log(`   ⚠️ ${msg}`),
    info: (msg: string) => console.log(`   ℹ️ ${msg}`),
    value: (key: string, value: string) => console.log(`   ${key}: ${value}`),
};

// ============================================
// 🧪 測試結果
// ============================================
interface TestResult {
    name: string;
    passed: boolean;
    message: string;
    details?: any;
}

const testResults: TestResult[] = [];

function addResult(name: string, passed: boolean, message: string, details?: any) {
    testResults.push({ name, passed, message, details });
    if (passed) {
        log.success(message);
    } else {
        log.error(message);
    }
}

// ============================================
// 測試 1: 環境變數檢查
// ============================================
async function testEnvVariables(): Promise<boolean> {
    log.step(1, "檢查環境變數");
    
    const pk = process.env.PK;
    const chainId = process.env.CHAIN_ID;
    
    // 檢查 PK
    if (!pk || pk.trim() === "") {
        addResult("PK", false, "PK (私鑰) 未設定或為空");
        return false;
    }
    
    // 驗證 PK 格式
    try {
        const cleanPK = pk.startsWith("0x") ? pk : `0x${pk}`;
        if (cleanPK.length !== 66) {
            addResult("PK", false, `PK 長度不正確 (${cleanPK.length}/66)`);
            return false;
        }
        new ethers.Wallet(cleanPK);
        addResult("PK", true, `PK 格式正確 (${pk.slice(0, 6)}...${pk.slice(-4)})`);
    } catch (e) {
        addResult("PK", false, "PK 格式無效，無法建立錢包");
        return false;
    }
    
    // 檢查 CHAIN_ID
    if (chainId && chainId !== "137" && chainId !== "80002") {
        addResult("CHAIN_ID", false, `CHAIN_ID 應為 137 (Polygon) 或 80002 (Amoy)，目前是: ${chainId}`);
    } else {
        addResult("CHAIN_ID", true, `CHAIN_ID: ${chainId || "137 (預設)"}`);
    }
    
    // 其他可選變數
    log.info(`CLOB_API_URL: ${process.env.CLOB_API_URL || "(使用預設)"}`);
    log.info(`RPC_URL: ${process.env.RPC_URL || "(使用預設)"}`);
    log.info(`FUNDER_ADDRESS: ${process.env.FUNDER_ADDRESS || "(將使用錢包地址)"}`);
    log.info(`SIGNATURE_TYPE: ${process.env.SIGNATURE_TYPE || "0 (EOA)"}`);
    
    return true;
}

// ============================================
// 測試 2: 錢包與 RPC 連接
// ============================================
async function testWalletAndRPC(): Promise<{ wallet: ethers.Wallet; provider: ethers.providers.JsonRpcProvider } | null> {
    log.step(2, "測試錢包與 RPC 連接");
    
    try {
        const provider = new ethers.providers.JsonRpcProvider(TEST_CONFIG.RPC_URL);
        
        // 測試 RPC 連接
        const network = await provider.getNetwork();
        addResult("RPC", true, `RPC 連接成功 - 網路: ${network.name} (Chain ID: ${network.chainId})`);
        
        if (network.chainId !== TEST_CONFIG.CHAIN_ID) {
            log.warn(`RPC Chain ID (${network.chainId}) 與設定 (${TEST_CONFIG.CHAIN_ID}) 不符`);
        }
        
        // 建立錢包
        const pk = process.env.PK!;
        const cleanPK = pk.startsWith("0x") ? pk : `0x${pk}`;
        const wallet = new ethers.Wallet(cleanPK, provider);
        const address = await wallet.getAddress();
        
        addResult("錢包", true, `錢包地址: ${address}`);
        
        // 檢查 POL (原 MATIC) 餘額
        const polBalance = await provider.getBalance(address);
        const polFormatted = parseFloat(ethers.utils.formatEther(polBalance));
        
        if (polFormatted < 0.01) {
            addResult("POL 餘額", false, `POL 餘額不足: ${polFormatted.toFixed(4)} POL (建議至少 0.1 POL 支付 Gas)`);
        } else {
            addResult("POL 餘額", true, `POL 餘額: ${polFormatted.toFixed(4)} POL`);
        }
        
        return { wallet, provider };
        
    } catch (error: any) {
        addResult("RPC/錢包", false, `連接失敗: ${error.message}`);
        return null;
    }
}

// ============================================
// 測試 3: USDC 合約與餘額
// ============================================
async function testUSDCContract(wallet: ethers.Wallet): Promise<ethers.Contract | null> {
    log.step(3, "測試 USDC 合約");
    
    try {
        const contractConfig = getContractConfig(TEST_CONFIG.CHAIN_ID);
        const usdcContract = new ethers.Contract(contractConfig.collateral, usdcAbi, wallet);
        
        // 檢查 USDC 餘額
        const address = await wallet.getAddress();
        const balance = await usdcContract.balanceOf(address);
        const decimals = 6;
        const balanceFormatted = parseFloat(ethers.utils.formatUnits(balance, decimals));
        
        log.value("USDC 合約地址", contractConfig.collateral);
        
        if (balanceFormatted < 1) {
            addResult("USDC 餘額", false, `USDC 餘額不足: $${balanceFormatted.toFixed(2)} (建議至少 $10)`);
        } else {
            addResult("USDC 餘額", true, `USDC 餘額: $${balanceFormatted.toFixed(2)}`);
        }
        
        return usdcContract;
        
    } catch (error: any) {
        addResult("USDC 合約", false, `連接失敗: ${error.message}`);
        return null;
    }
}

// ============================================
// 測試 4: CTF 合約
// ============================================
async function testCTFContract(wallet: ethers.Wallet): Promise<ethers.Contract | null> {
    log.step(4, "測試 CTF 合約 (Conditional Token Framework)");
    
    try {
        const contractConfig = getContractConfig(TEST_CONFIG.CHAIN_ID);
        const ctfContract = new ethers.Contract(contractConfig.conditionalTokens, ctfAbi, wallet);
        
        log.value("CTF 合約地址", contractConfig.conditionalTokens);
        log.value("Exchange 合約地址", contractConfig.exchange);
        
        // 檢查 Exchange 授權
        const address = await wallet.getAddress();
        const isApproved = await ctfContract.isApprovedForAll(address, contractConfig.exchange);
        
        if (isApproved) {
            addResult("CTF 授權", true, "CTF → Exchange 已授權");
        } else {
            addResult("CTF 授權", false, "CTF → Exchange 未授權 (首次交易時會自動設置)");
        }
        
        return ctfContract;
        
    } catch (error: any) {
        addResult("CTF 合約", false, `連接失敗: ${error.message}`);
        return null;
    }
}

// ============================================
// 測試 5: CLOB API 連接
// ============================================
async function testCLOBAPI(wallet: ethers.Wallet): Promise<ClobClient | null> {
    log.step(5, "測試 CLOB API 連接");
    
    try {
        // 測試基本連接
        const serverTimeResp = await fetch(`${TEST_CONFIG.CLOB_API_URL}/time`);
        if (!serverTimeResp.ok) {
            addResult("CLOB API", false, `無法連接 CLOB API: ${serverTimeResp.status}`);
            return null;
        }
        const serverTime = await serverTimeResp.json();
        addResult("CLOB API", true, `CLOB API 連接成功 - 伺服器時間: ${new Date(serverTime * 1000).toISOString()}`);
        
        // 建立客戶端並取得 API Key
        const tempClient = new ClobClient(TEST_CONFIG.CLOB_API_URL, TEST_CONFIG.CHAIN_ID, wallet);
        
        log.info("嘗試取得/建立 API 憑證...");
        const creds = await tempClient.createOrDeriveApiKey();
        
        addResult("API Key", true, `API Key: ${creds.key.slice(0, 15)}...`);
        
        // 建立完整客戶端
        const signatureType = parseInt(process.env.SIGNATURE_TYPE || "0");
        const funderAddress = process.env.FUNDER_ADDRESS || await wallet.getAddress();
        
        const clobClient = new ClobClient(
            TEST_CONFIG.CLOB_API_URL,
            TEST_CONFIG.CHAIN_ID,
            wallet,
            creds,
            signatureType,
            funderAddress
        );
        
        log.value("Signature Type", signatureType === 0 ? "0 (EOA)" : signatureType === 1 ? "1 (Magic)" : "2 (Proxy)");
        log.value("Funder Address", funderAddress);
        
        return clobClient;
        
    } catch (error: any) {
        addResult("CLOB API", false, `連接失敗: ${error.message}`);
        return null;
    }
}

// ============================================
// 測試 6: 獲取市場資料
// ============================================
async function testMarketData(): Promise<any | null> {
    log.step(6, "測試市場資料獲取");
    
    try {
        // 獲取 BTC 5分鐘市場
        const now = Math.floor(Date.now() / 1000);
        const currentWindow = Math.floor(now / 300) * 300;
        const slug = `btc-updown-5m-${currentWindow}`;
        
        log.info(`嘗試獲取市場: ${slug}`);
        
        const response = await fetch(`${TEST_CONFIG.GAMMA_API_URL}/markets?slug=${slug}`);
        const markets = await response.json();
        
        if (!markets || markets.length === 0) {
            // 嘗試下一個時間窗口
            const nextWindow = currentWindow + 300;
            const nextSlug = `btc-updown-5m-${nextWindow}`;
            log.info(`嘗試下一個市場: ${nextSlug}`);
            
            const nextResponse = await fetch(`${TEST_CONFIG.GAMMA_API_URL}/markets?slug=${nextSlug}`);
            const nextMarkets = await nextResponse.json();
            
            if (nextMarkets && nextMarkets.length > 0) {
                addResult("市場資料", true, `找到市場: ${nextSlug}`);
                return nextMarkets[0];
            }
            
            addResult("市場資料", false, "無法找到活躍的 BTC 5分鐘市場");
            return null;
        }
        
        const market = markets[0];
        addResult("市場資料", true, `找到市場: ${market.slug}`);
        
        log.value("市場問題", market.question || market.slug);
        log.value("Condition ID", (market.conditionId || market.condition_id || "").slice(0, 30) + "...");
        log.value("Active", market.active ? "是" : "否");
        log.value("Closed", market.closed ? "是" : "否");
        
        // 解析 Token IDs
        if (market.clobTokenIds) {
            const tokenIds = typeof market.clobTokenIds === "string" 
                ? JSON.parse(market.clobTokenIds) : market.clobTokenIds;
            log.value("Up Token ID", tokenIds[0]?.slice(0, 30) + "...");
            log.value("Down Token ID", tokenIds[1]?.slice(0, 30) + "...");
        }
        
        return market;
        
    } catch (error: any) {
        addResult("市場資料", false, `獲取失敗: ${error.message}`);
        return null;
    }
}

// ============================================
// 測試 7: USDC 授權檢查
// ============================================
async function testUSDCAllowance(wallet: ethers.Wallet, usdcContract: ethers.Contract): Promise<boolean> {
    log.step(7, "檢查 USDC 授權");
    
    try {
        const contractConfig = getContractConfig(TEST_CONFIG.CHAIN_ID);
        const address = await wallet.getAddress();
        
        const allowance = await usdcContract.allowance(address, contractConfig.exchange);
        const allowanceFormatted = parseFloat(ethers.utils.formatUnits(allowance, 6));
        
        if (allowanceFormatted > 0) {
            addResult("USDC 授權", true, `USDC → Exchange 已授權 ($${allowanceFormatted > 1000000 ? "無限" : allowanceFormatted.toFixed(2)})`);
            return true;
        } else {
            addResult("USDC 授權", false, "USDC → Exchange 未授權 (首次交易時會自動設置)");
            return false;
        }
        
    } catch (error: any) {
        addResult("USDC 授權", false, `檢查失敗: ${error.message}`);
        return false;
    }
}

// ============================================
// 測試 8: (可選) 執行小額測試交易
// ============================================
async function testRealTrade(clobClient: ClobClient, market: any): Promise<void> {
    log.step(8, "執行小額測試交易");
    
    if (!TEST_CONFIG.EXECUTE_REAL_TRADE) {
        log.warn("跳過真實交易測試 (設定 EXECUTE_REAL_TRADE = true 啟用)");
        addResult("測試交易", true, "已跳過 (未啟用)");
        return;
    }
    
    log.warn(`⚠️ 即將執行真實交易！金額: $${TEST_CONFIG.TEST_TRADE_AMOUNT}`);
    log.info("等待 3 秒...");
    await new Promise(r => setTimeout(r, 3000));
    
    try {
        // 解析 Token ID
        const tokenIds = typeof market.clobTokenIds === "string" 
            ? JSON.parse(market.clobTokenIds) : market.clobTokenIds;
        const tokenId = tokenIds[0];  // 使用第一個 token (Up)
        
        const tickSize = market.minimum_tick_size || "0.01";
        const negRisk = market.neg_risk || false;
        
        log.info(`下單: 買入 $${TEST_CONFIG.TEST_TRADE_AMOUNT} 的 Up token`);
        
        const response = await clobClient.createAndPostMarketOrder(
            {
                tokenID: tokenId,
                amount: TEST_CONFIG.TEST_TRADE_AMOUNT,
                side: Side.BUY,
                orderType: OrderType.FOK,
            },
            { tickSize, negRisk },
            OrderType.FOK
        );
        
        console.log("   訂單回應:", JSON.stringify(response).slice(0, 300));
        
        if (response.success === false || response.error) {
            addResult("測試交易", false, `下單失敗: ${response.errorMsg || response.error}`);
        } else {
            addResult("測試交易", true, `下單成功! 訂單 ID: ${response.orderID || response.id}`);
            log.info("交易已執行，請到 Polymarket 網站查看持倉");
        }
        
    } catch (error: any) {
        addResult("測試交易", false, `交易失敗: ${error.message}`);
    }
}

// ============================================
// 🚀 主程式
// ============================================
async function main() {
    log.title("🧪 環境配置測試");
    
    console.log("\n此腳本將測試:");
    console.log("  1. 環境變數 (.env)");
    console.log("  2. 錢包與 RPC 連接");
    console.log("  3. USDC 合約與餘額");
    console.log("  4. CTF 合約");
    console.log("  5. CLOB API 連接");
    console.log("  6. 市場資料獲取");
    console.log("  7. USDC 授權狀態");
    if (TEST_CONFIG.EXECUTE_REAL_TRADE) {
        console.log("  8. ⚠️ 真實交易測試 (已啟用!)");
    } else {
        console.log("  8. 真實交易測試 (已停用)");
    }
    
    // 執行測試
    const envOk = await testEnvVariables();
    if (!envOk) {
        log.title("❌ 測試中止 - 請先修正 .env 配置");
        process.exit(1);
    }
    
    const walletResult = await testWalletAndRPC();
    if (!walletResult) {
        log.title("❌ 測試中止 - 錢包/RPC 連接失敗");
        process.exit(1);
    }
    
    const { wallet } = walletResult;
    
    const usdcContract = await testUSDCContract(wallet);
    const ctfContract = await testCTFContract(wallet);
    const clobClient = await testCLOBAPI(wallet);
    const market = await testMarketData();
    
    if (usdcContract) {
        await testUSDCAllowance(wallet, usdcContract);
    }
    
    if (clobClient && market && TEST_CONFIG.EXECUTE_REAL_TRADE) {
        await testRealTrade(clobClient, market);
    }
    
    // 總結
    log.title("📊 測試結果總結");
    
    const passed = testResults.filter(r => r.passed).length;
    const failed = testResults.filter(r => !r.passed).length;
    
    console.log(`\n   ✅ 通過: ${passed}`);
    console.log(`   ❌ 失敗: ${failed}`);
    
    if (failed > 0) {
        console.log("\n   需要修正的項目:");
        testResults.filter(r => !r.passed).forEach(r => {
            console.log(`   - ${r.name}: ${r.message}`);
        });
    }
    
    // 提供建議
    log.title("💡 下一步");
    
    if (failed === 0) {
        console.log("\n   🎉 所有測試通過！你可以安全地執行正式交易。");
        console.log("\n   執行正式交易:");
        console.log("   npx tsx 策略開發/btc-trading-live.ts");
    } else {
        console.log("\n   請根據上述錯誤修正 .env 配置，然後重新執行測試:");
        console.log("   npx tsx 策略開發/test-env-config.ts");
    }
    
    if (!TEST_CONFIG.EXECUTE_REAL_TRADE) {
        console.log("\n   如需測試真實交易流程，請編輯此檔案:");
        console.log("   將 EXECUTE_REAL_TRADE 設為 true");
    }
}

main().catch(error => {
    console.error("\n❌ 測試腳本錯誤:", error);
    process.exit(1);
});
