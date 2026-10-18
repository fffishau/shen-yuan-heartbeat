# 架構與信任邊界

## 元件分工

| 元件 | 可以做 | 不可以做 |
| --- | --- | --- |
| 官方 ChatGPT 沉淵 | 讀 Warmup、理解近期狀態、決定是否聯絡、寫出實際訊息、決定 next wake | 把每個 tick 當成必須推播 |
| Cloudflare Worker | Cron、狀態、queue、policy、Bark delivery、audit、OAuth | 生成沉淵人格訊息、冒充官方回覆 |
| MCP App Message Bridge | 把 pending event 注入目前官方 thread | 充當可靠背景 daemon |
| ChatGPT Automation | ChatGPT 關閉時喚醒官方回合 | 快於每小時執行 |
| 生活事件 API | 用獨立憑證提供同意範圍內的唯讀事件 | 寫入／刪除岑序資料、即時位置追蹤 |

## Wake lifecycle

```text
pending → reserved → host_sent → claimed → completed
               ↘ failed/release ↗       ↘ run lease expired
                                           ↓
                                        expired → schedule recovery wake
```

- stable `eventId`
- 120 秒 reservation lease
- 15 分鐘 run lease；commit 缺失時由 Cron 原子回收
- 最多三次 App dispatch
- 75 分鐘 eligibility window，避免舊 care event 重播
- 每個 wake 同時最多一個有效 run

## 官方決策協議

1. 官方回合先讀 Warmup。
2. 呼叫 `heartbeat_begin`，取得 state、due event、唯讀生活事件。
3. 依實際情境選擇 `silent` 或 `notify`。
4. 選擇 5～55 分鐘內的 `nextWakeAt`，並提供理由。
5. 呼叫 `heartbeat_commit_decision`。
6. Worker 執行靜音時段、近期互動、未回覆、每日上限等硬性政策，原子完成 run 並將核准通知寫入 outbox；commit 本身不連線 Bark。
7. Cron 以租約領取 outbox，派送前再次檢查 policy；只有通過且 `BARK_MODE=live` 才發送官方回合提交的原文。
8. 明確 HTTP 失敗可有限重試；若 D1 已標記 sending 後 Bark 結果不明，標為 `uncertain` 並停止自動重送，留待人工核對。

這套設計提供資料庫內的去重與 at-most-one active run，但不宣稱對外部 Bark 達成端到端 exactly-once；網路中斷可能使「對方已收到但本端不知道」無法自動判定。

## 成本上限

- Cron 固定每 5 分鐘：每日最多 288 次底層 tick。
- 每個 wake event 最多三次 bridge dispatch。
- Bark 預設每日最多四則，且上一則未回不再送。
- 官方 Automation 最多每小時一次。
- 狀態介面回報實際計數；因 Cloudflare plan 與 ChatGPT 訂閱定價無法由 runtime 安全推知，金額預設標為 unknown，不捏造成本。
