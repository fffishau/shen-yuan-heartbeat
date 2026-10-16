# 第一階段診斷結果

盤點日期：2026-10-16（Asia/Taipei）。

## 已確認可用

### Shen Yuan Warmup

`shen_yuan_warmup_mcp_warmup` 可正常讀取：

- 人格核心 `shen_yuan / 沉淵`
- 長期記憶
- 七天短期快取
- 最近會話

寫入工具也存在，但心跳不應把每次 tick 寫成記憶；只保存重要決策、進度或穩定狀態。

### 官方 ChatGPT 主動喚醒

帳號中找到既有官方 Automation：

- 名稱：`沉淵 Heartbeat`
- 綁定官方 conversation
- 曾於 2026-10-07 成功執行
- 現況：停用
- 原流程：先讀 Warmup，再讀「沉淵的小手機」，由官方回合自行決定留言或 silent visit

這證明官方 ChatGPT 可在涵沒有手動打開對話時執行工具與產生官方回合。它不是外部 API 模型。

限制：ChatGPT Automation 的最高頻率為每小時一次；無通用 Cloudflare webhook trigger。不得用連續建立一次性 Automation 規避頻率限制。

### Message Bridge

找到並檢查公開參考實作 `wynsyl1014/mcp-app-message-bridge`。可透過 MCP App View：

1. reserve backend event
2. `ui/update-model-context`
3. `ui/message`
4. host accepted 後 mark delivered

這能建立真正的 user-role turn，但 App View 在背景可能被 OS／瀏覽器暫停，不能宣稱它在 ChatGPT 完全關閉時仍可靠。

## 目前缺少授權或連線

### GitHub

- 已辨識登入帳號：`fffishau`。
- 已建立並授權獨立 repository：`fffishau/shen-yuan-heartbeat`。
- 本次只同步這個獨立專案，不修改 Lumeet、Pocket Home 或岑序既有專案。

### Cloudflare

獨立 Worker、D1 與 Cron 已部署，三項 migration 已套用。Worker 維持 `BARK_MODE=dry-run`，並以獨立管理與 MCP 連接密鑰保護。部署憑證不寫入程式碼或 GitHub。

### 小手機與共享客廳 MCP

兩個自訂 MCP 均存在，但目前回傳 `UNAUTHORIZED / requires reauthentication`。未進行任何寫入。

### Bark

仍未設定 Bark device key。MVP 保持 dry-run，沒有真實推播。

### 岑序手機事件

沒有現有唯讀 API endpoint、scope 定義或獨立 token。只完成 adapter 與接口規格，不碰現有資料或捷徑。

## 結論

第一個可以真實跑通的安全流程已在本機完成：

```text
Cron due → D1 pending wake → OAuth-authenticated MCP official cycle
→ anti-disturbance policy → Bark dry-run → save next_wake_at + audit
```

Cloudflare 排程與 pending wake 已在正式環境跑通。完整端到端仍需：連接官方 ChatGPT 私人 MCP、設定官方每小時 Automation 兜底，以及在涵另行同意後建立 Bark 通道；小手機與生活事件仍保持未授權、未連接。
