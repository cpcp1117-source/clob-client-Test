/**
 * 簡化版 Logger - 使用 console + 檔案輸出
 */
import fs from "fs";
import path from "path";

const logsDir = path.resolve(process.cwd(), "logs");

// 確保 logs 目錄存在
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
}

const formatDate = () => new Date().toISOString();

const writeToFile = (level: string, msg: string, data?: object) => {
    const logLine = JSON.stringify({
        time: formatDate(),
        level,
        msg,
        ...data
    }) + "\n";
    
    fs.appendFileSync(path.join(logsDir, "trading.json.log"), logLine);
    
    if (level === "error") {
        fs.appendFileSync(path.join(logsDir, "error.log"), logLine);
    }
};

export const logger = {
    info: (msg: string, data?: object) => {
        console.log(`[${formatDate()}] INFO: ${msg}`, data || "");
        writeToFile("info", msg, data);
    },
    warn: (msg: string, data?: object) => {
        console.warn(`[${formatDate()}] WARN: ${msg}`, data || "");
        writeToFile("warn", msg, data);
    },
    error: (msg: string, data?: object) => {
        console.error(`[${formatDate()}] ERROR: ${msg}`, data || "");
        writeToFile("error", msg, data);
    },
    debug: (msg: string, data?: object) => {
        if (process.env.LOG_LEVEL === "debug") {
            console.debug(`[${formatDate()}] DEBUG: ${msg}`, data || "");
            writeToFile("debug", msg, data);
        }
    }
};

export default logger;
