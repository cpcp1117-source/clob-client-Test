import { sendDiscordNotification } from './discord-notifier';

console.log('🧪 測試開始：發送包含引號的訊息...');
const message = `🎯 【測試通知】\n狀況: "下單成功"\n詳情: "這是一個測試訊息，用以驗證雙引號是否仍會導致失敗"。\n時間: ${new Date().toLocaleString()}`;

try {
    sendDiscordNotification(message);
    console.log('✅ 測試指令已發出。請檢查您的 Discord 頻道是否收到訊息。');
    console.log('如果訊息成功出現，表示引號衝突問題已解決。');
} catch (err) {
    console.error('❌ 測試失敗:', err);
}
