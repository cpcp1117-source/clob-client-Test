# 基礎設施設定

本地端 ELK Stack 用於交易日誌分析。

## 啟動服務

```powershell
# 啟動 Elasticsearch + Kibana
docker-compose up -d

# 啟動 Filebeat (日誌收集)
.\start-filebeat.ps1
```

## 存取方式

- **Elasticsearch**: http://localhost:9200
- **Kibana**: http://localhost:5601

## 注意事項

- 確保 Docker Desktop 已啟動
- Filebeat 設定檔中的 `paths` 可能需要根據實際日誌位置調整
