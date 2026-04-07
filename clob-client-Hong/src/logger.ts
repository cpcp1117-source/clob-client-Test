import pino from "pino";
import path from "path";
import pretty from "pino-pretty";
import { execSync } from "child_process";

/**
 * 🚀 Polymarket 交易機器人結構化日誌工具 (修正版)
 * 
 * 解決 Windows 中文路徑亂碼方案：
 * 1. 強制 stdout 使用 UTF-8
 * 2. 使用 multistream 確保 Console 輸出在主執行緒中執行，避免跨執行緒編碼丟失
 */

// 強制設定標準輸出編碼
if (process.platform === 'win32') {
    try {
        // 強制 Windows 控制台進入 UTF-8 模式 (CP 65001)
        execSync('chcp 65001', { stdio: 'ignore' });
    } catch (e) {
        // 忽略錯誤
    }
}

const logsDir = path.resolve(process.cwd(), "logs");

/**
 * 檔案日誌傳輸 (使用 Worker Thread 以提高性能)
 */
const fileTransport = pino.transport({
    targets: [
        {
            target: 'pino-roll',
            options: {
                file: path.join(logsDir, 'trading.json.log'),
                frequency: 'daily',
                mkdir: true,
            },
            level: 'info'
        },
        {
            target: 'pino/file',
            options: {
                destination: path.join(logsDir, 'error.log'),
                mkdir: true,
            },
            level: 'error'
        }
    ]
});

/**
 * 控制台輸出流 (使用主執行緒以確保 chcp 65001 生效)
 */
const consoleStream = pretty({
    colorize: true,
    translateTime: 'SYS:yyyy-mm-dd HH:MM:ss',
    ignore: 'pid,hostname',
    sync: true // 強制同步輸出到 stdout
});

export const logger = pino(
    {
        level: process.env.LOG_LEVEL || 'info',
    },
    pino.multistream([
        { stream: consoleStream, level: 'info' },
        { stream: fileTransport, level: 'info' }
    ])
);

export default logger;
