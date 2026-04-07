import { spawnSync } from 'child_process';
import * as path from 'path';
import { logger } from '../../clob-client-Hong/src/logger';

/**
 * 📢 Discord 通知工具
 * 
 * 透過呼叫專案 LazyGravity 的 CLI 指令來發送訊息。
 * 這樣您就不需要在交易程式中重複設定 Discord Token。
 */

// 設定 LazyGravity 的絕對路徑
const LAZY_GRAVITY_DIR = 'e:\\反重力通知\\LazyGravity';
const CLI_RELATIVE_PATH = 'src/bin/cli.ts';

/**
 * 發送 Discord 通知
 * @param message 要發送的訊息內容
 */
export function sendDiscordNotification(message: string): void {
    try {
        // 使用 spawnSync 並以數組傳遞內容，避免 Windows shell 引號衝突問題
        // 使用絕對路徑並停用 shell 以確保參數傳遞完全不被解析器干擾
        const result = spawnSync('C:\\Program Files\\nodejs\\npx.cmd', ['ts-node', CLI_RELATIVE_PATH, 'notify', message], {
            cwd: LAZY_GRAVITY_DIR,
            shell: false, 
            encoding: 'utf-8'
        });

        if (result.status !== 0) {
            logger.error({ 
                status: result.status, 
                stderr: result.stderr?.toString().trim() 
            }, '❌ Discord 通知發送失敗 (CLI 傳回錯誤)');
        }
    } catch (error: any) {
        logger.error({ error: error.message || error }, '❌ Discord 通知發送異常 (系統錯誤)');
    }
}


// 測試用：如果直接執行此檔案 (npx ts-node discord-notifier.ts)
if (import.meta.url.endsWith(process.argv[1]) || process.argv[1]?.endsWith('discord-notifier.ts')) {
    console.log('🧪 正在測試 Discord 通知...');
    sendDiscordNotification('🔔 來自交易系統的測試通知：連線正常！');
}
