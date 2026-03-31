// 搜索 BTC 5分鐘市場（帶時間戳格式）
async function searchBTC5MinMarkets() {
    console.log("🔍 搜索 BTC 5分鐘市場...\n");
    
    const now = new Date();
    const nowTimestamp = Math.floor(now.getTime() / 1000);
    
    console.log(`當前時間 (UTC): ${now.toISOString()}`);
    console.log(`當前時間 (ET): ${new Date(now.getTime() - 4 * 60 * 60 * 1000).toISOString().slice(0, 19)}`);
    console.log(`當前 Unix 時間戳: ${nowTimestamp}`);
    console.log("");
    
    // 計算最近的5分鐘時間窗口
    // 5分鐘 = 300秒
    const currentWindow = Math.floor(nowTimestamp / 300) * 300;
    const nextWindow = currentWindow + 300;
    const prevWindow = currentWindow - 300;
    
    console.log(`上一個窗口時間戳: ${prevWindow} (${new Date(prevWindow * 1000).toISOString()})`);
    console.log(`當前窗口時間戳: ${currentWindow} (${new Date(currentWindow * 1000).toISOString()})`);
    console.log(`下一個窗口時間戳: ${nextWindow} (${new Date(nextWindow * 1000).toISOString()})`);
    console.log("");
    
    // 嘗試搜索這些時間戳的市場
    const timestampsToTry = [
        prevWindow - 300,
        prevWindow,
        currentWindow,
        nextWindow,
        nextWindow + 300,
    ];
    
    console.log("📋 嘗試搜索以下市場 slug:\n");
    
    for (const ts of timestampsToTry) {
        const slug = `btc-updown-5m-${ts}`;
        const endTime = new Date(ts * 1000).toISOString();
        
        console.log(`  嘗試: ${slug}`);
        console.log(`        結束時間: ${endTime}`);
        
        try {
            const response = await fetch(
                `https://gamma-api.polymarket.com/markets?slug=${slug}`
            );
            const markets = await response.json();
            
            if (markets && markets.length > 0) {
                const market = markets[0];
                console.log(`  ✅ 找到！`);
                console.log(`     Question: ${market.question}`);
                console.log(`     Active: ${market.active}, Closed: ${market.closed}`);
                console.log(`     Outcomes: ${market.outcomes}`);
                console.log(`     Prices: ${market.outcomePrices}`);
                console.log("");
            } else {
                console.log(`  ❌ 未找到\n`);
            }
        } catch (error) {
            console.log(`  ❌ 查詢失敗: ${error}\n`);
        }
    }
    
    // 也嘗試用 event slug 格式搜索
    console.log("\n" + "=".repeat(50));
    console.log("📋 嘗試搜索 events...\n");
    
    for (const ts of timestampsToTry.slice(1, 4)) {
        const slug = `btc-updown-5m-${ts}`;
        
        try {
            const response = await fetch(
                `https://gamma-api.polymarket.com/events?slug=${slug}`
            );
            const events = await response.json();
            
            if (events && events.length > 0) {
                const event = events[0];
                console.log(`✅ 找到 Event: ${slug}`);
                console.log(`   Title: ${event.title}`);
                console.log(`   Markets: ${event.markets?.length || 0} 個`);
                
                if (event.markets) {
                    event.markets.forEach((m: any, i: number) => {
                        console.log(`   ${i + 1}. ${m.question}`);
                        console.log(`      Active: ${m.active}, Closed: ${m.closed}`);
                    });
                }
                console.log("");
            }
        } catch (error) {
            // 忽略
        }
    }
    
    // 搜索所有包含 "btc-updown" 的活躍市場
    console.log("\n" + "=".repeat(50));
    console.log("📋 搜索所有 btc-updown 活躍市場...\n");
    
    try {
        // 用 Gamma API 搜索
        const response = await fetch(
            "https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=100"
        );
        const markets = await response.json();
        
        const btcUpdownMarkets = markets.filter((m: any) => {
            const slug = (m.slug || "").toLowerCase();
            return slug.includes("btc-updown") || slug.includes("bitcoin-up");
        });
        
        console.log(`找到 ${btcUpdownMarkets.length} 個 btc-updown 活躍市場`);
        
        btcUpdownMarkets.forEach((m: any, i: number) => {
            console.log(`\n${i + 1}. ${m.question}`);
            console.log(`   Slug: ${m.slug}`);
            console.log(`   End: ${m.endDate || m.end_date_iso}`);
            console.log(`   Active: ${m.active}, Closed: ${m.closed}`);
            console.log(`   Prices: ${m.outcomePrices}`);
        });
        
        if (btcUpdownMarkets.length === 0) {
            console.log("\n❌ 目前沒有活躍的 BTC 5分鐘市場");
            console.log("\n可能的原因：");
            console.log("  1. BTC 5分鐘市場只在特定時段開放（可能是美國交易時間）");
            console.log("  2. 市場暫時關閉或維護中");
            console.log("  3. 需要在 Polymarket 網站上確認市場開放時間");
            console.log("\n建議：");
            console.log("  - 訪問 https://polymarket.com 查看是否有 BTC 5分鐘市場");
            console.log("  - 記下市場的 slug，然後在機器人中使用 SPECIFIC_MARKET_SLUG 配置");
        }
        
    } catch (error) {
        console.error("❌ 搜索失敗:", error);
    }
}

searchBTC5MinMarkets();
