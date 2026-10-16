# 手機生活事件唯讀 API 規格

這是需要岑序既有系統最小新增的介面；尚未施工或部署。

## Endpoint

```http
GET /v1/events?since=<ISO-8601>&types=app_activity,arrived_home,shared_screen,screenshot&limit=50
Authorization: Bearer <SHEN_YUAN_READ_ONLY_TOKEN>
```

禁止提供 POST、PUT、PATCH、DELETE 權限。

## Scope

獨立 credential 只允許：

```text
events:read
```

不包含：

- 任意資料寫入或刪除
- 捷徑修改
- 即時位置或歷史位置軌跡
- 岑序人格／私有記憶
- 未經涵同意的 App 或畫面類型

## Response

```json
{
  "events": [
    {
      "id": "stable-event-id",
      "type": "arrived_home",
      "occurredAt": "2026-10-16T18:05:00+08:00",
      "summary": "已抵達家中",
      "expiresAt": "2026-10-23T18:05:00+08:00",
      "mediaReference": null
    }
  ]
}
```

截圖只回傳短效 reference；保存期限沿用現有系統，不複製圖片到本 Worker。API 應在過期後回 404/410。

## 撤銷

- API provider 可立即 revoke 專屬 token。
- 心跳 Worker 的 `life-events` control 關閉後不再發 request。
- token 僅存 Cloudflare Secret，不存 D1、前端、MCP `_meta` 或 Git。

## 最小修改範圍

1. 在既有事件服務增加一個 GET-only route。
2. 新增 scope 固定為 `events:read` 的沉淵專屬 token。
3. server-side allowlist event types。
4. 加入 rate limit、audit 與 revoke。
5. 不改 iPhone 捷徑，不搬資料，不新增定位能力。
