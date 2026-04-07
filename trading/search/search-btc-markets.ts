// 搜索當前活躍的 BTC 市場
async function searchBTCMarkets() {
    console.log("🔍 搜索活躍的 BTC 市場...\n");
    
    try {
        const response = await fetch(
            "https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=100"
        );
        const markets = await response.json();
        
        // 過濾 BTC 相關市場
        const btcMarkets = markets.filter((m: any) => 
            m.slug && (
                m.slug.toLowerCase().includes("btc") || 
                m.question?.toLowerCase().includes("bitcoin")
            )
        );
        
        console.log(`找到 ${btcMarkets.length} 個 BTC 相關市場:\n`);
        
        btcMarkets.slice(0, 10).forEach((m: any, i: number) => {
            console.log(`${i + 1}. ${m.question}`);
            console.log(`   Slug: ${m.slug}`);
            console.log(`   Active: ${m.active}, Closed: ${m.closed}`);
            console.log(`   Outcomes: ${m.outcomes}`);
            console.log(`   Prices: ${m.outcomePrices}`);
            console.log("");
        });
        
        // 顯示所有市場類型
        console.log("\n📋 所有活躍市場類型統計:");
        const slugPrefixes: Record<string, number> = {};
        markets.forEach((m: any) => {
            if (m.slug) {
                const prefix = m.slug.split("-").slice(0, 2).join("-");
                slugPrefixes[prefix] = (slugPrefixes[prefix] || 0) + 1;
            }
        });
        
        Object.entries(slugPrefixes)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 15)
            .forEach(([prefix, count]) => {
                console.log(`   ${prefix}: ${count} 個`);
            });
            
    } catch (error) {
        console.error("❌ 搜索失敗:", error);
    }
}

searchBTCMarkets();
