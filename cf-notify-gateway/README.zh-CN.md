# CF Notify Gateway

[English](./README.md) | [简体中文](./README.zh-CN.md)

一个无依赖的 Cloudflare Worker：接收版本化 `task.finished` Webhook，并行向 Discord 和 Telegram 发送同一条纯文本通知。它不依赖 OMP，任何实现下述协议的发送端都可复用。

## 本地开发

聚焦测试使用内存 provider mock，不会请求 Discord 或 Telegram：

```bash
cd cf-notify-gateway
bun test
```

如需在本地运行 Worker，请创建不会纳入版本控制的 `cf-notify-gateway/.dev.vars`，写入 `INBOUND_SECRET`、`DISCORD_WEBHOOK_URL`、`TELEGRAM_BOT_TOKEN` 和 `TELEGRAM_CHAT_ID`，然后启动 Wrangler：

```bash
bun run dev
```

Wrangler 会在本地提供网关服务。有效的 `POST /hook` 会向所配置的 provider 发送请求；不需要出站发送时请使用 mock 测试。

## 部署

```bash
cd cf-notify-gateway
npx wrangler login
npx wrangler secret put INBOUND_SECRET
npx wrangler secret put DISCORD_WEBHOOK_URL
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
bun run deploy
```

不要把 secret 值写进 `wrangler.toml` 或提交到仓库。

| Secret | 值 |
| --- | --- |
| `INBOUND_SECRET` | 足够长的随机 Bearer secret；与发送端的 `OMP_NOTIFY_TOKEN` 使用同一值。 |
| `DISCORD_WEBHOOK_URL` | Discord 频道 Webhook 完整地址。 |
| `TELEGRAM_BOT_TOKEN` | BotFather 签发的 bot token。 |
| `TELEGRAM_CHAT_ID` | 目标用户、群组或频道 chat ID。 |

部署后，发送端 URL 配置为 `https://<worker>.<account>.workers.dev/hook`。

## 请求协议

向 `/hook` 发送 `POST`，请求头：

```http
Authorization: Bearer <INBOUND_SECRET>
Content-Type: application/json
```

版本 1 请求体：

```json
{
  "schemaVersion": 1,
  "eventId": "018f-example-event",
  "event": "task.finished",
  "source": "omp",
  "title": "当前会话标题",
  "directory": "/work/project",
  "durationMs": 60000,
  "status": "completed"
}
```

`status` 必须是 `completed`、`failed`、`cancelled` 或 `unknown`。`durationMs` 必须是有限的非负数，且不大于 `Number.MAX_SAFE_INTEGER`。请求体上限 32 KiB；event ID、标题和目录分别最多 128、4096 和 8192 个 JavaScript code unit。超过通道消息上限时只截断标题和目录，始终保留耗时与状态。

## 手机通知内容

两端收到相同纯文本，不使用 Markdown，也不调用模型改写：

```text
Task: 当前会话标题
Directory: /work/project
Duration: 1m 0s
Status: completed
```

Discord mentions 已禁用。手机通知不包含 provider 凭据或协议元数据。

## 发送语义

Discord 与 Telegram 同时开始发送。每个通道有独立 5 秒超时，覆盖响应头和响应体读取。Discord 要求 HTTP 2xx；Telegram 同时要求 HTTP 成功且 JSON 响应中的 `ok` 为 `true`，HTTP 200 但 `ok: false` 仍视为失败。

| HTTP 状态 | 含义 |
| --- | --- |
| `200` | 两个通道都发送成功。 |
| `207` | 仅一个通道发送成功。 |
| `502` | 两个通道都失败。 |
| `400` | JSON 或事件 schema 无效。 |
| `401` | Bearer secret 缺失或错误。 |
| `404` / `405` / `415` | 路径、方法或 Content-Type 错误。 |
| `413` | 请求体超过 32 KiB。 |
| `503` | 一个或多个必需的网关 secret 未配置。 |

响应只暴露各通道的 `sent`/`failed`/`unknown` 状态，不返回 provider 响应体或 secret。`unknown` 表示请求可能已到达 provider，但超时、网络失败或无效确认使网关无法证明结果。

网关采用 best-effort 语义：没有队列、重试循环或持久化 `eventId` 去重。OMP 发送端会阻止同一进程内的一次任务重复结算；其他发送端如需重试，应自行定义幂等策略。

## 测试

```bash
bun test
```
