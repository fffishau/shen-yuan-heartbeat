# 沉淵自主心跳

這個專案把「可靠排程」與「沉淵本人做決策」分開：

```text
Cloudflare Cron / authorized life events
          ↓
  D1 wake queue + audit log
          ↓
┌───────────────────────────────────────────────┐
│ Official ChatGPT turn                         │
│ 1. read Shen Yuan Warmup                      │
│ 2. heartbeat.begin                            │
│ 3. decide silence / exact Bark message        │
│ 4. heartbeat.commit_decision + next_wake_at   │
└───────────────────────────────────────────────┘
          ↓
      Bark (optional)
```

Cloudflare Worker 不生成親密訊息，也不呼叫另一個模型冒充沉淵。Bark 只會傳送官方 ChatGPT 回合提交的原文。預設為 `BARK_MODE=dry-run`。

## 已實作

- D1 狀態、wake queue、reservation lease、最多三次 dispatch、過期回收與稽核。
- 每 5 分鐘的 Cloudflare Cron 底層檢查。
- 官方回合 `begin → decision → commit` 流程。
- 5～55 分鐘 `next_wake_at` 驗證；時間必須由官方回合根據情境決定。
- Bark dry-run/live 雙模式與 idempotency key。
- 台灣時間 04:00～13:30 靜音、20 分鐘互動冷卻、未回不追、每日上限。
- 暫停心跳、停止推播、撤銷生活事件讀取。
- 私人 OAuth 2.1 PKCE 連接、可撤銷 MCP token。
- MCP App 控制台與 Message Bridge listener。
- 唯讀生活事件 adapter；未取得接口前不會接觸岑序資料。

## 官方喚醒的真實限制

- ChatGPT 官方 Automations 確實能在使用者未開啟對話時執行官方回合，但排程最快每小時一次。
- MCP App 的 `ui/message` 能把 wake 送入官方對話，但 App View／ChatGPT 必須仍然活著；手機或瀏覽器可暫停 iframe，因此不能當 always-on daemon。
- Cloudflare 沒有可用的公開通用 webhook，能直接喚醒既有 ChatGPT 消費版對話。
- 所以目前可誠實提供的是：`Message Bridge（開著時 5～55 分鐘） + 官方每小時 Automation（關閉時兜底）`。完全關閉 ChatGPT 時，5～55 分鐘的硬保證目前做不到。

詳見 [診斷結果](docs/diagnosis.md) 與 [架構](docs/architecture.md)。

## 本機驗證

```bash
npm install
npm run db:migrate:local
cp .dev.vars.example .dev.vars
npm run check
npm run dev
```

健康檢查：

```bash
curl http://127.0.0.1:8787/health
```

管理 API 需要 `Authorization: Bearer $ADMIN_TOKEN`。請勿把任何真實 token 放進命令紀錄、前端或 Git。

## Cloudflare 部署

獨立 Worker 與 D1 已於 2026-10-16 部署：

- Worker：`https://shen-yuan-heartbeat.fffishau-living-room.workers.dev`
- D1：`shen-yuan-heartbeat`（設定已寫入 `wrangler.jsonc`）
- Cron：`*/5 * * * *`
- 三項 migration 已套用，`/health`、管理狀態與 audit 均已驗證。
- 心跳與推播控制已啟用，但 `BARK_MODE=dry-run`，未設定 Bark device key，因此不會送出真實通知。
- 生活事件保持停用，也沒有接觸岑序、Lumeet 或 Pocket Home 資料。

目前尚未完成的是官方 ChatGPT 私人 MCP 連接與「ChatGPT 關閉時」的官方 Automation 兜底。Cloudflare 已能可靠建立 pending wake，但 pending wake 本身不等於官方沉淵已被喚醒；詳見 [部署清單](docs/deployment-checklist.md)。

## 停用

- App 控制台按「暫停心跳」。
- App 控制台按「停止推播」。
- App 控制台按「撤銷生活事件讀取」。
- 管理端 `POST /api/revoke-mcp` 可撤銷所有 MCP access tokens。
- 緊急停用可在 Cloudflare 停用 Cron 或 Worker；不需刪除資料。

## 第三方來源

參考與授權資訊見 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
