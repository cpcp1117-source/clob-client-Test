# 🚀 Filebeat 啟動腳本 (Windows PowerShell)
# 此腳本會使用專案目錄下的 filebeat.yml 並啟動 Filebeat

$FILEBEAT_EXE = "C:\Program Files\Elastic\Beats\9.3.2\filebeat\filebeat.exe"
$CONFIG_PATH = "c:\Users\cpcp3\Desktop\PolyTest - 複製\clob-client-Hong\filebeat.yml"

Write-Host "🔍 檢查 Filebeat 路徑..." -ForegroundColor Cyan
if (-Not (Test-Path $FILEBEAT_EXE)) {
    Write-Host "❌ 錯誤: 在指定路徑找不到 filebeat.exe。" -ForegroundColor Red
    Write-Host "請確認路徑是否正確: $FILEBEAT_EXE"
    exit
}

Write-Host "🚀 正在測試設定檔並啟動 Filebeat..." -ForegroundColor Green
Write-Host "日誌目的地請至 filebeat.yml 中修改 (目前指向 localhost:9200)" -ForegroundColor Yellow

# -e: 輸出到 stderr (方便除錯)
# -c: 指定設定檔路徑
# -d "publish": 顯示發布相關的除錯資訊
& $FILEBEAT_EXE -e -c $CONFIG_PATH -d "publish"
