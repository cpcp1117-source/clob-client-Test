import { config as dotenvConfig } from "dotenv";
import { resolve } from "path";

dotenvConfig({ path: resolve(import.meta.dirname, "../.env") });

async function getMarketBySlug() {
    console.log("🔍 查詢特定市場...\n");

    // 從 URL 提取 slug
    const slug = "btc-updown-5m-1774715100";
    
    try {
        // 方式1：使用 Gamma API（推薦）
        console.log("📌 方式1：使用 Gamma API 查詢特定 slug");
        console.log(`   Slug: ${slug}\n`);
        
        const gammaApiUrl = `https://gamma-api.polymarket.com/markets?slug=${slug}`;
        console.log(`   API URL: ${gammaApiUrl}\n`);
        
        const response = await fetch(gammaApiUrl);
        
        if (!response.ok) {
            console.log(`❌ API 請求失敗: ${response.status}`);
            return;
        }

        const markets = await response.json();
        
        if (!markets || markets.length === 0) {
            console.log(`❌ 找不到 slug 為 "${slug}" 的市場`);
            console.log(`   可能原因：`);
            console.log(`   1. Slug 拼寫錯誤`);
            console.log(`   2. 市場已關閉或不存在`);
            return;
        }

        const market = markets[0];
        
        console.log(`✅ 找到市場！\n`);
        console.log(`📊 基本信息：`);
        console.log(`   Question: ${market.question}`);
        console.log(`   Slug: ${market.slug}`);
        console.log(`   Condition ID: ${market.condition_id}`);
        console.log(`   Status: ${market.active ? "活躍" : "已關閉"}`);
        
        // 顯示原始 API 返回的完整數據（用於調試）
        console.log(`\n📋 完整 API 返回數據：`);
        console.log(JSON.stringify(market, null, 2).split('\n').slice(0, 30).join('\n'));
        console.log(`   ...（更多數據）...`);
        
        // Token 信息
        if (market.tokens && market.tokens.length > 0) {
            console.log(`\n💰 合約信息：`);
            market.tokens.forEach((token: any, i: number) => {
                console.log(`   ${i + 1}. ${token.ticker}`);
                console.log(`      Token ID: ${token.token_id}`);
                if (token.price) console.log(`      Price: $${parseFloat(token.price).toFixed(4)}`);
            });
        } else {
            console.log(`\nℹ️  此市場沒有 tokens 數據`);
        }

        // 流動性和交易量
        console.log(`\n📈 交易數據：`);
        if (market.volume_24hr) {
            const vol = typeof market.volume_24hr === "string" ? parseFloat(market.volume_24hr) : market.volume_24hr;
            console.log(`   24小時成交量: $${vol.toFixed(2)}`);
        }
        if (market.liquidity) {
            const liq = typeof market.liquidity === "string" ? parseFloat(market.liquidity) : market.liquidity;
            console.log(`   流動性: $${liq.toFixed(2)}`);
        }

        // 市場時限
        if (market.end_date_iso) {
            console.log(`\n⏰ 市場到期時間：`);
            console.log(`   ${new Date(market.end_date_iso).toLocaleString("zh-CN")}`);
        }

        console.log("\n" + "=".repeat(50));
        console.log("✨ 成功查詢市場信息！\n");
        
        // 提供下一步操作提示
        if (market.tokens && market.tokens.length > 0) {
            console.log("🎯 下一步操作：");
            console.log(`   1. 查看訂單簿: npx tsx test-orderbook.ts ${market.tokens[0].token_id}`);
            console.log(`   2. 查看價格: npx tsx test-price.ts ${market.tokens[0].token_id}`);
        }
        
        // 返回 market 供下一步使用
        return market;

    } catch (error) {
        console.log(`❌ 查詢失敗: ${error}`);
    }
}

// 2. 或者使用 CLOB Client 的 getMarket（需要 condition ID）
async function getMarketByClobClient() {
    console.log("\n\n📌 方式2：如果已知 Condition ID，可使用 CLOB Client\n");
    
    console.log("✅ 用法示例：");
    console.log(`   const clobClient = new ClobClient(apiUrl, chainId);`);
    console.log(`   const market = await clobClient.getMarket("condition_id_here");`);
}

// 執行
(async () => {
    await getMarketBySlug();
    await getMarketByClobClient();
})();
