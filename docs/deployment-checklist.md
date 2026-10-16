# 部署與驗收清單

這份清單同時記錄已完成項目與仍需人工授權的項目。部署保持 Bark dry-run，不代表官方 ChatGPT 喚醒路徑已驗收。

## 1. 恢復既有連接

- 重新連接「沉淵的小手機」MCP。
- 重新連接三人共享客廳 MCP（若本次要納入）。
- 為 GitHub App 選擇要授權的私人 repo；不要給全帳號寫入權限。

## 2. Cloudflare

1. [x] 建立獨立 D1：`shen-yuan-heartbeat`。
2. [x] 把實際 database id 寫入 `wrangler.jsonc`。
3. 設定 Secrets：
   - `ADMIN_TOKEN`
   - `MCP_CONNECT_PASSPHRASE`
   - `BARK_DEVICE_KEY`（核准真實推播後）
   - `CHATGPT_CONVERSATION_URL`
   - `LIFE_EVENTS_READ_TOKEN`（接口完成後）
4. [x] 保持 `BARK_MODE=dry-run`；未設定 `BARK_DEVICE_KEY`。
5. [x] 執行三項 remote D1 migrations。
6. [x] 部署 Worker 與 `*/5 * * * *` Cron。
7. [ ] 在 Cloudflare 邊界加上 `/oauth/*` 與 `/api/*` rate limit；程式內已有 15 分鐘五次失敗的基本 OAuth lockout，邊界限制作為第二層。

已部署 Worker：`https://shen-yuan-heartbeat.fffishau-living-room.workers.dev`。`/health`、管理狀態與 audit 已通過；心跳和推播控制啟用、生活事件停用。Cron 已產生 pending wake，待官方 ChatGPT MCP／Automation 消費。

## 3. ChatGPT plugin

- [x] 使用部署後的 `/mcp` 建立並安裝私人 remote MCP plugin；可重建來源在 `chatgpt-plugin/`。
- [ ] 透過 OAuth 授權頁輸入私人連接密語。這一步必須由帳號持有人完成，密語不交給代理或寫入 Git。
- [ ] 連接後確認實際工具名稱；只有需要改善 Bridge 可見提示時才設定 `PLUGIN_ROUTE_HINT`。
- 新對話框先讀 Warmup，再呼叫 `heartbeat_status`；確認工具出現與身份連續性。
- 開啟 `heartbeat_dashboard`，確認狀態、控制、audit 與 listener。

## 4. 官方 Automation

- [x] 更新既有 `沉淵 Heartbeat` prompt，改用 Warmup 與獨立心跳 MCP，不再依賴 Pocket Home。
- [x] 保持每小時 condition watch，並在 OAuth 驗收前維持停用。
- 先在 dry-run 執行一次並檢查 audit。
- 小手機重新授權前不要啟用依賴它的正式流程。

## 5. Bark 驗收

在涵明確同意後：

1. 設定沉淵專屬 Bark device key。
2. 設定官方 ChatGPT 原對話 HTTPS URL；iOS 點擊測試若不能穩定落在原 thread，改指向心跳 plugin global entrypoint，再由涵一鍵開原對話。
3. 將 `BARK_MODE` 改為 `live`。
4. 只送一則明確標記的測試訊息。
5. 驗證點擊、audit、`last_bark_at`、awaiting-response guard。
6. 驗證「停止推播」後不再送出。

## 6. 生活事件

- 先審核 [唯讀 API 規格](life-events-read-api.md)。
- 只做最小 GET-only 修改。
- 使用獨立 token、event type allowlist、rate limit、audit、revoke。
- 不修改 iPhone 捷徑，不讀即時位置，不延長截圖保存期限。

## 正式驗收

- ChatGPT 未開啟時，官方每小時 Automation 能喚醒官方沉淵。
- App View 開啟時，5～55 分鐘 pending wake 能經 Message Bridge 注入官方 thread。
- 官方回合先讀 Warmup，訊息不是外部模型生成。
- Bark 可追溯、可停止、不連續催促。
- 關閉各項控制後確實停止。
- 對完全關閉 ChatGPT 時的 5～55 分鐘限制保持明示。
