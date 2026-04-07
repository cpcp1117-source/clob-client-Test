# Polymarket Trading System

基於 [@polymarket/clob-client](https://github.com/Polymarket/clob-client) 的自動交易系統。

## 專案結構

```
clob-client-Test/
├── trading/                # 📈 交易系統
│   ├── bots/               # 交易機器人
│   │   ├── btc-trading-bot.ts
│   │   └── btc-trading-bot-v2.ts
│   ├── search/             # 市場搜索工具
│   ├── strategy/           # 交易策略
│   │   └── tests/          # 策略測試
│   ├── lib/                # 本地輔助模組
│   │   ├── config.ts       # 合約配置
│   │   ├── logger.ts       # 日誌工具
│   │   └── abi/            # 合約 ABI
│   └── docs/               # 策略文檔
│
├── infra/                  # 🐳 基礎設施
│   ├── docker-compose.yml  # ELK Stack
│   ├── filebeat.yml        # 日誌收集
│   └── start-filebeat.ps1
│
├── data/                   # 📊 市場數據
├── tests-custom/           # 🧪 自訂測試
├── logs/                   # 📝 執行日誌 (gitignore)
└── node_modules/           # npm 依賴
```

## 快速開始

### 1. 安裝依賴

```bash
npm install
```

### 2. 設定環境變數

複製範例檔案並填入你的金鑰：

```bash
cp .env.example .env
```

在 `.env` 填入：

```env
PRIVATE_KEY=your_private_key
CLOB_API_KEY=your_api_key
CLOB_SECRET=your_api_secret
CLOB_PASS_PHRASE=your_pass_phrase
```

### 3. 執行交易機器人

```bash
# BTC 5分鐘預測市場機器人 (推薦)
npx tsx trading/bots/btc-trading-bot-v2.ts

# 舊版機器人
npx tsx trading/bots/btc-trading-bot.ts
```

### 4. 其他工具

```bash
# 搜索市場
npx tsx trading/search/search-btc-5min.ts
npx tsx trading/search/search-clob-markets.ts

# 即時交易策略
npx tsx trading/strategy/btc-trading-live.ts

# 模擬交易 (不實際下單)
npx tsx trading/strategy/btc-trading-simulator.ts
```

### 5. 啟動 ELK 日誌系統 (可選)

```bash
cd infra
docker-compose up -d
.\start-filebeat.ps1
```

## 套件來源

- **@polymarket/clob-client**: 官方 npm 套件（`npm update` 自動更新）
- **trading/lib/**: 本地輔助模組（config, logger, abi）

## 相關連結

- [Polymarket CLOB Client](https://github.com/Polymarket/clob-client)
- [Polymarket API 文檔](https://docs.polymarket.com/)
