// 使用 CLOB API 搜索 5分鐘市場
import { config as dotenvConfig } from "dotenv";
import { resolve } from "path";
import { ClobClient, Chain } from "@polymarket/clob-client";

dotenvConfig({ path: resolve(import.meta.dirname, "../../.env") });

async function searchCLOBMarkets() {
    console.log("🔍 使用 CLOB API 搜索市場...\n");
    
    const now = new Date();
    const nowUTC = now.toISOString();
    const nowET = new Date(now.getTime() - 4 * 60 * 60 * 1000).toISOString(); // UTC-4 for ET
    
    console.log(`當前時間 (UTC): ${nowUTC}`);
    console.log(`當前時間 (ET): ${nowET.replace('T', ' ').slice(0, 19)}`);
    console.log("");
    
    const chainId = parseInt(`${process.env.CHAIN_ID || 137}`) as Chain;
    const apiUrl = process.env.CLOB_API_URL || "https://clob.polymarket.com";
    
    const clobClient = new ClobClient(apiUrl, chainId);
    
    try {
        // 獲取市場列表
        console.log("📋 從 CLOB API 獲取市場...\n");
        
        let allMarkets: any[] = [];
        let cursor = "MA=="; // 初始 cursor
        let page = 0;
        
        // 獲取多頁市場
        while (page < 5) {
            const response = await clobClient.getMarkets(cursor);
            
            if (!response.data || response.data.length === 0) break;
            
            allMarkets = allMarkets.concat(response.data);
            
            if (!response.next_cursor || response.next_cursor === "LTE=") break;
            cursor = response.next_cursor;
            page++;
        }
        
        console.log(`總共獲取 ${allMarkets.length} 個市場\n`);
        
        // 過濾短期市場（到期時間在接下來30分鐘內）
        const shortTermMarkets = allMarkets.filter((m: any) => {
            // 檢查 slug 是否包含 5分鐘市場關鍵字
            const slug = (m.market_slug || "").toLowerCase();
            const question = (m.question || "").toLowerCase();
            
            const is5Min = slug.includes("5m") || 
                           slug.includes("updown") ||
                           question.includes("up or down");
            
            // 檢查到期時間
            if (m.end_date_iso || m.game_start_time) {
                const endDate = new Date(m.end_date_iso || m.game_start_time);
                const diffMinutes = (endDate.getTime() - now.getTime()) / (1000 * 60);
                
                // 接下來30分鐘內到期
                if (diffMinutes > 0 && diffMinutes <= 30) {
                    return true;
                }
            }
            
            return is5Min;
        });
        
        console.log(`找到 ${shortTermMarkets.length} 個短期/5分鐘市場:\n`);
        
        // 顯示市場
        shortTermMarkets.slice(0, 10).forEach((m: any, i: number) => {
            console.log(`${i + 1}. ${m.question || m.description}`);
            console.log(`   Condition ID: ${m.condition_id}`);
            console.log(`   Market Slug: ${m.market_slug}`);
            console.log(`   End Date: ${m.end_date_iso}`);
            
            if (m.tokens && m.tokens.length > 0) {
                console.log(`   Tokens:`);
                m.tokens.forEach((t: any) => {
                    console.log(`     - ${t.outcome}: ${t.token_id}`);
                });
            }
            console.log("");
        });
        
        // 也顯示一些 BTC 相關的市場
        console.log("\n" + "=".repeat(50));
        console.log("📋 所有包含 'btc', 'bitcoin', 'up' 或 'down' 的市場:\n");
        
        const relevantMarkets = allMarkets.filter((m: any) => {
            const slug = (m.market_slug || "").toLowerCase();
            const question = (m.question || "").toLowerCase();
            const desc = (m.description || "").toLowerCase();
            
            return slug.includes("btc") || 
                   slug.includes("bitcoin") ||
                   question.includes("bitcoin") ||
                   question.includes("up or down") ||
                   slug.includes("updown");
        });
        
        console.log(`找到 ${relevantMarkets.length} 個相關市場\n`);
        
        relevantMarkets.slice(0, 10).forEach((m: any, i: number) => {
            const endDate = m.end_date_iso;
            let timeInfo = "";
            if (endDate) {
                const diff = (new Date(endDate).getTime() - now.getTime()) / (1000 * 60);
                timeInfo = `(${diff > 0 ? `還有 ${diff.toFixed(0)} 分鐘` : "已過期"})`;
            }
            
            console.log(`${i + 1}. ${m.question || m.description}`);
            console.log(`   Slug: ${m.market_slug}`);
            console.log(`   End: ${endDate} ${timeInfo}`);
            console.log(`   Active: ${m.active}, Closed: ${m.closed}`);
            console.log("");
        });
        
        // 顯示市場 slug 模式統計
        console.log("\n" + "=".repeat(50));
        console.log("📊 市場 Slug 模式統計:\n");
        
        const slugPatterns: Record<string, number> = {};
        allMarkets.forEach((m: any) => {
            const slug = m.market_slug || "";
            // 提取 slug 的前綴（例如 "nba-", "nfl-", "btc-updown-"）
            const match = slug.match(/^([a-z]+-[a-z]+(-[a-z]+)?)/i);
            if (match) {
                const pattern = match[1];
                slugPatterns[pattern] = (slugPatterns[pattern] || 0) + 1;
            }
        });
        
        Object.entries(slugPatterns)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 20)
            .forEach(([pattern, count]) => {
                console.log(`  ${pattern}: ${count} 個`);
            });
            
    } catch (error) {
        console.error("❌ 搜索失敗:", error);
    }
}

searchCLOBMarkets();
