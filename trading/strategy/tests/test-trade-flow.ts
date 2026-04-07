import { ethers } from "ethers";
import { config as dotenvConfig } from "dotenv";
import { resolve } from "path";
import { ClobClient, Chain, Side, OrderType, SignatureType, type ApiKeyCreds } from "../../../clob-client-Hong/src/index.ts";

dotenvConfig({ path: resolve(import.meta.dirname, "../.env") });

// --- 測試目標設定 ---
// 目標市場: Will the Iranian regime fall by April 30?
// https://polymarket.com/zh/event/will-the-iranian-regime-fall-by-april-30
const CONDITION_ID = "0xe443dab97ad8b7f58558cc7a6a3932d156031e962a451e0461e9a4578d78fe84";
// YES 與 NO Tokens
const YES_TOKEN_ID = "48764428286656921488851644351774667118009263342042758531252625616470924946480";
const NO_TOKEN_ID = "45752951190517118746418545365916139233368614665273368123939609626397431866529";

async function main() {
    console.log("=== Polymarket 獲取市場報價測試 (伊朗政權市場) ===");
    
    // 初始化客戶端
    const chainId = parseInt(`${process.env.CHAIN_ID || 137}`) as Chain;
    const apiUrl = process.env.CLOB_API_URL || "https://clob.polymarket.com";
    const clobClient = new ClobClient(apiUrl, chainId);

    // ==========================================
    // 1. 取得 YES 與 NO 報價並格式化輸出
    // ==========================================
    const yesOrderbook = await clobClient.getOrderBook(YES_TOKEN_ID);
    let yesBestAsk = 0;
    if (yesOrderbook.asks.length > 0) {
        yesBestAsk = yesOrderbook.asks.map((a: any) => parseFloat(a.price)).sort((a: number, b: number) => a - b)[0];
    }

    const noOrderbook = await clobClient.getOrderBook(NO_TOKEN_ID);
    let noBestAsk = 0;
    if (noOrderbook.asks.length > 0) {
        noBestAsk = noOrderbook.asks.map((a: any) => parseFloat(a.price)).sort((a: number, b: number) => a - b)[0];
    }

    const now = new Date().toLocaleTimeString("zh-TW");
    const yesStr = yesBestAsk > 0 ? `$${yesBestAsk.toFixed(3)}` : "無報價";
    const noStr = noBestAsk > 0 ? `$${noBestAsk.toFixed(3)}` : "無報價";

    // ==========================================
    // 3. 取得目前錢包可用餘額
    // ==========================================
    const wallet = new ethers.Wallet(process.env.PK || "");
    const funderAddress = process.env.FUNDER_ADDRESS; // 你的 Polymarket 網頁實際 Proxy 地址
    // Proxy 錢包必須使用 POLY_GNOSIS_SAFE 作為簽章類型
    const sigType = funderAddress ? SignatureType.POLY_GNOSIS_SAFE : SignatureType.EOA;

    const creds: ApiKeyCreds | undefined = process.env.CLOB_API_KEY ? {
        key: process.env.CLOB_API_KEY,
        secret: process.env.CLOB_SECRET || "",
        passphrase: process.env.CLOB_PASS_PHRASE || "",
    } : undefined;

    let authClient = new ClobClient(apiUrl, chainId, wallet, creds, sigType, funderAddress);

    try {
        // 如果連 API Key 都沒有設定，我們先自動創建
        if (!creds || !creds.key) {
            console.log(`[${now}] 🔄 | 未在 .env 偵測到 API 金鑰，正在透過私鑰自動向 Polymarket 獲取...`);
            const newCreds = await authClient.createOrDeriveApiKey();
            console.log(`\n======================================`);
            console.log(`✅ 成功獲取新金鑰! 請務必將以下內容複製並更新到您的 .env 檔案中：`);
            console.log(`CLOB_API_KEY=${newCreds.key}`);
            console.log(`CLOB_SECRET=${newCreds.secret}`);
            console.log(`CLOB_PASS_PHRASE=${newCreds.passphrase}`);
            console.log(`======================================\n`);
            authClient = new ClobClient(apiUrl, chainId, wallet, newCreds, sigType, funderAddress);
        }

        let balanceResponse: any = await authClient.getBalanceAllowance({ asset_type: "COLLATERAL" as any });
        
        // Polymarket API 會用 HTTP 401 配合 JSON {"error": "Unauthorized/Invalid api key"} 返回
        if (balanceResponse && balanceResponse.error) {
            console.log(`\n[${now}] ⚠️ | API 金鑰無效或過期: ${balanceResponse.error}`);
            console.log(`[${now}] 🔄 | 正在透過您的私鑰 (PK) 自動向 Polymarket 重新註冊/獲取有效的 API 金鑰...`);
            
            // 透過錢包簽章重新註冊或找回金鑰
            const newCreds = await authClient.createOrDeriveApiKey();
            console.log(`\n======================================`);
            console.log(`✅ 成功獲取新金鑰! 請務必將以下內容複製並更新到您的 .env 檔案中：`);
            console.log(`CLOB_API_KEY=${newCreds.key}`);
            console.log(`CLOB_SECRET=${newCreds.secret}`);
            console.log(`CLOB_PASS_PHRASE=${newCreds.passphrase}`);
            console.log(`======================================\n`);
            
            // 更換客戶端憑證並重新查詢
            authClient = new ClobClient(apiUrl, chainId, wallet, newCreds);
            balanceResponse = await authClient.getBalanceAllowance({ asset_type: "COLLATERAL" as any });
        }

        if (balanceResponse && typeof balanceResponse.balance !== "undefined") {
            const rawBalance = parseFloat(balanceResponse.balance);
            // 通常 USDC 小數點位數是 6 (10^6)，需要進行轉換才是實際美元金額
            const actualBalance = rawBalance / 1e6;
            console.log(`[${now}] 📌 | 當前查詢之錢包地址 (PK): ${wallet.address}`);
            console.log(`[${now}] 💰 | 錢包可用現金 (USDC/USDC.e): $${actualBalance.toFixed(2)}`);
            
            // ==========================================
            // 4. 測試下單與撤單 (只有在餘額獲取成功時才執行)
            // ==========================================
            if (actualBalance >= 0.05) {
                console.log(`\n======================================`);
                console.log(`[${now}] 🤖 | 開始測試下單與撤單功能...`);
                try {
                    // 掛一個不可能立刻成交的超低買單 (YES, 買 5 股 @ $0.01 = $0.05 USDC)
                    const testPrice = 0.01;
                    const testSize = 5;
                    console.log(`[${now}] ➡️ | 準備掛單: 限價買入 YES, 數量: ${testSize}, 價格: $${testPrice} ...`);
                    
                    const orderResponse = await authClient.createAndPostOrder(
                        {
                            tokenID: YES_TOKEN_ID,
                            price: testPrice,
                            side: Side.BUY,
                            size: testSize,
                        },
                        { tickSize: "0.01" }, // 伊朗市場 tick size 通常為 0.01
                        OrderType.GTC
                    );

                    if (orderResponse && orderResponse.success) {
                        console.log(`[${now}] ✅ | 掛單成功! 訂單 ID: ${orderResponse.orderID}`);
                        console.log(`[${now}] ⏳ | 【請去網頁確認】這張掛單現在應該會出現在你的「未結訂單 (Orders)」裡面...`);
                        console.log(`[${now}] ⏳ | 程式等待 5 秒鐘後，將自動執行撤單...`);
                        
                        // 暫停 5 秒讓使用者可以親眼看看網頁
                        await new Promise(resolve => setTimeout(resolve, 5000));
                        
                        console.log(`[${now}] ➡️ | 準備撤銷訂單: ${orderResponse.orderID} ...`);
                        const cancelResp = await authClient.cancelOrder({ orderID: orderResponse.orderID });
                        console.log(`[${now}] ✅ | 撤單完成! 您可以回到網頁確認訂單是否已消失。`);
                    } else {
                        console.log(`[${now}] ❌ | 掛單失敗: ${orderResponse?.errorMsg || JSON.stringify(orderResponse)}`);
                    }
                } catch (err: any) {
                    console.log(`[${now}] ❌ | 交易流程發生異常: ${err.message}`);
                }
            } else {
                console.log(`[${now}] ⚠️ | 可用餘額不足 $0.05，無法進行安全掛單測試。`);
            }
            
        } else {
            console.log(`[${now}] ⚠️ | 取得餘額返回未知格式:`, balanceResponse);
        }
    } catch (err: any) {
        console.log(`[${now}] ⚠️ | 取得流程發生系統錯誤 (${err.message})`);
    }
}

main().catch(console.error);
