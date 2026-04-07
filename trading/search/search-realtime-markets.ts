// 搜索即時的 BTC 5分鐘市場
async function searchRealtime5MinMarkets() {
    console.log("🔍 搜索即時 BTC 5分鐘市場...\n");
    
    const now = new Date();
    console.log(`當前時間 (UTC): ${now.toISOString()}`);
    console.log(`當前時間 (本地): ${now.toLocaleString("zh-TW")}\n`);
    
    try {
        // 搜索所有活躍市場
        const response = await fetch(
            "https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=500"
        );
        const markets = await response.json();
        
        console.log(`總共找到 ${markets.length} 個活躍市場\n`);
        
        // 過濾 5分鐘市場 (包含 "5m" 或短期到期)
        const shortTermMarkets = markets.filter((m: any) => {
            const slug = (m.slug || "").toLowerCase();
            const question = (m.question || "").toLowerCase();
            
            // 檢查是否是 5分鐘市場
            const is5Min = slug.includes("5m") || 
                           slug.includes("updown") ||
                           question.includes("5 minute") ||
                           question.includes("5m");
            
            // 檢查到期時間是否在接下來30分鐘內
            if (m.endDate || m.end_date_iso) {
                const endDate = new Date(m.endDate || m.end_date_iso);
                const diffMinutes = (endDate.getTime() - now.getTime()) / (1000 * 60);
                const isShortTerm = diffMinutes > 0 && diffMinutes <= 30;
                
                if (isShortTerm) {
                    return true;
                }
            }
            
            return is5Min;
        });
        
        console.log(`找到 ${shortTermMarkets.length} 個短期/5分鐘市場:\n`);
        
        if (shortTermMarkets.length === 0) {
            console.log("❌ 沒有找到活躍的5分鐘市場\n");
            console.log("可能原因：");
            console.log("  1. 5分鐘市場只在特定時間開放（例如交易時段）");
            console.log("  2. 當前沒有新的5分鐘市場");
            console.log("  3. 市場名稱/slug格式已更改\n");
            
            // 顯示所有包含 btc 的市場
            console.log("📋 所有包含 'btc' 或 'bitcoin' 的市場：");
            const btcMarkets = markets.filter((m: any) => {
                const slug = (m.slug || "").toLowerCase();
                const question = (m.question || "").toLowerCase();
                return slug.includes("btc") || question.includes("bitcoin");
            });
            
            btcMarkets.forEach((m: any, i: number) => {
                const endDate = m.endDate || m.end_date_iso;
                console.log(`\n${i + 1}. ${m.question}`);
                console.log(`   Slug: ${m.slug}`);
                console.log(`   到期: ${endDate}`);
                if (endDate) {
                    const diff = (new Date(endDate).getTime() - now.getTime()) / (1000 * 60);
                    console.log(`   距離到期: ${diff.toFixed(1)} 分鐘`);
                }
            });
        } else {
            shortTermMarkets.forEach((m: any, i: number) => {
                const endDate = m.endDate || m.end_date_iso;
                const diffMinutes = endDate 
                    ? ((new Date(endDate).getTime() - now.getTime()) / (1000 * 60)).toFixed(1)
                    : "未知";
                    
                console.log(`${i + 1}. ${m.question}`);
                console.log(`   Slug: ${m.slug}`);
                console.log(`   到期: ${endDate}`);
                console.log(`   距離到期: ${diffMinutes} 分鐘`);
                console.log(`   Outcomes: ${m.outcomes}`);
                console.log(`   Prices: ${m.outcomePrices}`);
                console.log("");
            });
        }
        
        // 嘗試用不同的參數搜索
        console.log("\n" + "=".repeat(50));
        console.log("🔍 嘗試搜索 'btc-updown' slug...\n");
        
        const btcUpdownResponse = await fetch(
            "https://gamma-api.polymarket.com/markets?slug_contains=btc-updown&limit=20"
        );
        
        if (btcUpdownResponse.ok) {
            const btcUpdownMarkets = await btcUpdownResponse.json();
            console.log(`找到 ${btcUpdownMarkets.length} 個 btc-updown 市場`);
            
            btcUpdownMarkets.slice(0, 5).forEach((m: any, i: number) => {
                console.log(`\n${i + 1}. ${m.question}`);
                console.log(`   Slug: ${m.slug}`);
                console.log(`   Active: ${m.active}, Closed: ${m.closed}`);
                console.log(`   到期: ${m.endDate || m.end_date_iso}`);
            });
        }
            
    } catch (error) {
        console.error("❌ 搜索失敗:", error);
    }
}

searchRealtime5MinMarkets();
