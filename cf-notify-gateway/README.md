# CF Notify Gateway

[English](./README.md) | [简体中文](./README.zh-CN.md)

A dependency-free Cloudflare Worker that accepts the versioned `task.finished` webhook and sends one plain-text notification to Discord, Telegram, or both. When both are enabled, delivery starts in parallel. It is independent of OMP and can be reused by any sender that implements the protocol below.

## Local development

The focused suite uses in-memory provider mocks and makes no Discord or Telegram requests:

```bash
cd cf-notify-gateway
bun test
```

To run the Worker locally, create an untracked `cf-notify-gateway/.dev.vars` containing `INBOUND_SECRET` plus at least one channel: `DISCORD_WEBHOOK_URL`, or both `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`. Configure all three channel values to enable both providers. Then start Wrangler:

```bash
bun run dev
```

Wrangler serves the gateway locally. A valid `POST /hook` dispatches to the configured providers; use the mocked test suite when outbound delivery is not intended.

## Deploy

```bash
cd cf-notify-gateway
npx wrangler login
npx wrangler secret put INBOUND_SECRET

# Configure either channel or both:
npx wrangler secret put DISCORD_WEBHOOK_URL
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID

bun run deploy
```

Do not put secret values in `wrangler.toml` or commit them.

| Secret | Requirement | Value |
| --- | --- | --- |
| `INBOUND_SECRET` | Required | Long random bearer secret. Use the same value for the sender's `OMP_NOTIFY_TOKEN`. |
| `DISCORD_WEBHOOK_URL` | Optional channel | Full Discord channel webhook URL. |
| `TELEGRAM_BOT_TOKEN` | Optional channel pair | Token issued by BotFather. Must be configured with `TELEGRAM_CHAT_ID`. |
| `TELEGRAM_CHAT_ID` | Optional channel pair | Target user, group, or channel chat ID. Must be configured with `TELEGRAM_BOT_TOKEN`. |

After deployment, configure the sender's URL as `https://<worker>.<account>.workers.dev/hook`.

## Request protocol

`POST /hook` with these headers:

```http
Authorization: Bearer <INBOUND_SECRET>
Content-Type: application/json
```

Body schema version 1:

```json
{
  "schemaVersion": 1,
  "eventId": "018f-example-event",
  "event": "task.finished",
  "source": "omp",
  "title": "Current session title",
  "directory": "/work/project",
  "durationMs": 60000,
  "status": "completed"
}
```

`status` must be `completed`, `failed`, `cancelled`, or `unknown`. `durationMs` must be a finite non-negative number no greater than `Number.MAX_SAFE_INTEGER`. The gateway accepts request bodies up to 32 KiB, event IDs up to 128 code units, titles up to 4096, and directories up to 8192. Provider messages truncate only title and directory as needed; duration and status are always retained.

## Mobile message

Each enabled channel receives the same plain text. No Markdown or model rewriting is applied:

```text
Task: Current session title
Directory: /work/project
Duration: 1m 0s
Status: completed
```

Discord mentions are disabled. Provider credentials and protocol metadata are not included in the mobile message.

## Delivery semantics

Enabled channels start concurrently. Each request has an independent 5-second timeout covering both headers and response-body reading. Discord requires an HTTP 2xx response. Telegram requires both HTTP success and a JSON body with `ok: true`; HTTP 200 with `ok: false` is a failure.

| HTTP status | Meaning |
| --- | --- |
| `200` | Every enabled channel delivered. |
| `207` | Both channels are enabled and exactly one delivered. |
| `502` | No enabled channel could be confirmed as delivered. |
| `400` | Invalid JSON or event schema. |
| `401` | Missing or invalid bearer secret. |
| `404` / `405` / `415` | Wrong route, method, or content type. |
| `413` | Request body exceeds 32 KiB. |
| `503` | `INBOUND_SECRET` is missing, no channel is enabled, or Telegram is only partially configured. |

Responses expose only `sent`/`failed`/`unknown`/`disabled` channel states, never provider response bodies or secrets. `disabled` means that channel is not configured. `unknown` means the request may have reached the provider but a timeout, network failure, or malformed confirmation prevented proof.

The gateway is best-effort: it has no queue, retry loop, or durable `eventId` deduplication. The OMP sender prevents duplicate settlement within its live task, but callers that retry must own their idempotency policy.

## Test

```bash
bun test
```
