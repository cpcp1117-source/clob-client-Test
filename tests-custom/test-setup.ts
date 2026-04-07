import { ethers } from "ethers";
import { config as dotenvConfig } from "dotenv";
import { resolve } from "path";
import { ClobClient, Chain } from "@polymarket/clob-client";

dotenvConfig({ path: resolve(import.meta.dirname, "../.env") });

async function test() {
    console.log("🔍 驗證環境設置...\n");

    const chainId = parseInt(`${process.env.CHAIN_ID || 137}`) as Chain;
    const apiUrl = process.env.CLOB_API_URL || "https://clob.polymarket.com";

    // 1. 檢查私鑰（可選）
    let wallet = null;
    const pk = process.env.PK || "";
    if (pk && pk.length === 66 && pk.startsWith("0x")) {
        try {
            wallet = new ethers.Wallet(pk);
            const address = await wallet.getAddress();
            console.log("✅ 私鑰有效");
            console.log(`   錢包地址: ${address}`);
        } catch (error) {
            console.log("⚠️  私鑰格式錯誤，將以唯讀模式運行");
        }
    } else {
        console.log("ℹ️  未設置私鑰，以唯讀模式運行（只能查看數據，不能交易）");
    }

    // 2. 檢查 Chain ID
    console.log(`\n✅ Chain ID: ${chainId} (${chainId === 80002 ? "AMOY 測試網" : "Polygon 主網"})`);

    // 3. 檢查 API URL
    console.log(`✅ API URL: ${apiUrl}`);

    // 4. 測試 API 連接（使用 ClobClient）
    try {
        const clobClient = new ClobClient(apiUrl, chainId);
        
        // 獲取服務器時間
        const serverTime = await clobClient.getServerTime();
        console.log(`\n✅ API 連接成功`);
        console.log(`   服務器時間: ${serverTime}`);

        // 獲取市場列表
        const marketsResponse = await clobClient.getMarkets();
        console.log(`   找到 ${marketsResponse.data.length} 個市場`);

        // 顯示前3個市場
        if (marketsResponse.data.length > 0) {
            console.log(`\n📊 市場示例：`);
            marketsResponse.data.slice(0, 3).forEach((market: any, i: number) => {
                console.log(`   ${i + 1}. ${market.question || market.condition_id}`);
            });
        }
    } catch (error) {
        console.log(`❌ API 連接失敗: ${error}`);
    }

    console.log("\n" + "=".repeat(50));
    if (wallet) {
        console.log("✨ 完整模式：可以查看數據 + 進行交易");
        console.log("   下一步：運行 npx tsx examples/createOrDeriveApiKey.ts 獲取 API 密鑰");
    } else {
        console.log("✨ 唯讀模式：只能查看市場數據");
        console.log("   如需交易，請在 .env 中設置 PK（私鑰）");
    }
}

test();
