# Polymarket Trading System

基於 [@polymarket/clob-client](https://github.com/Polymarket/clob-client) 的自動交易系統。

## 專案結構

```
clob-client-Test/
├── clob-client-Hong/       # 🔒 原始 fork (Polymarket CLOB Client)
│   ├── src/                # 核心客戶端庫
│   ├── examples/           # 官方範例
│   └── tests/              # 原始測試
│
├── trading/                # 📈 交易系統
│   ├── bots/               # 交易機器人
│   │   ├── btc-trading-bot.ts
│   │   └── btc-trading-bot-v2.ts
│   ├── search/             # 市場搜索工具
│   ├── strategy/           # 交易策略
│   │   └── tests/          # 策略測試
│   └── docs/               # 策略文檔
│
├── infra/                  # 🐳 基礎設施
│   ├── docker-compose.yml  # ELK Stack
│   ├── filebeat.yml        # 日誌收集
│   └── start-filebeat.ps1
│
├── data/                   # 📊 市場數據
├── tests-custom/           # 🧪 自訂測試
└── logs/                   # 📝 執行日誌 (gitignore)
```

## 快速開始

### 1. 安裝依賴

```bash
cd clob-client-Hong
pnpm install
```

### 2. 設定環境變數

在 `clob-client-Hong/` 目錄下建立 `.env` 檔案：

```env
PRIVATE_KEY=your_private_key
CLOB_API_KEY=your_api_key
CLOB_SECRET=your_api_secret
CLOB_PASS_PHRASE=your_pass_phrase
```

### 3. 執行交易機器人

```bash
cd trading/bots
npx tsx btc-trading-bot-v2.ts
```

### 4. 啟動 ELK 日誌系統 (可選)

```bash
cd infra
docker-compose up -d
.\start-filebeat.ps1
```

## 上游同步

保持 `clob-client-Hong/` 乾淨以便與上游同步：

```bash
cd clob-client-Hong
git remote add upstream https://github.com/Polymarket/clob-client.git
git fetch upstream
git merge upstream/main
```

## 相關連結

- [Polymarket CLOB Client](https://github.com/Polymarket/clob-client)
- [Polymarket API 文檔](https://docs.polymarket.com/)
