<div align="center">

# OMP Task Timer

Show elapsed time and outcomes for [Oh My Pi](https://github.com/can1357/oh-my-pi) tasks.

[English](./README.md) | [简体中文](./README.zh-CN.md)

[![npm version](https://img.shields.io/npm/v/omp-task-timer?style=flat-square)](https://www.npmjs.com/package/omp-task-timer)
[![npm downloads](https://img.shields.io/npm/dm/omp-task-timer?style=flat-square)](https://www.npmjs.com/package/omp-task-timer)
[![license](https://img.shields.io/npm/l/omp-task-timer?style=flat-square)](./LICENSE)

</div>

`omp-task-timer` shows task duration and outcome in one muted line above the OMP editor. The line disappears when the next request starts.

```text
✓ Task finished · 12s
```

## Install

```bash
omp plugin install omp-task-timer
```

> [!IMPORTANT]
> OMP loads extensions at startup. Restart OMP after installing, updating, or removing this package.

## Results

| Outcome | Display |
| --- | --- |
| Completed | `✓ Task finished · 12s` |
| Failed | `✗ Task failed · 12s` |
| Interrupted with `Esc` | `■ Task interrupted · 12s` |

The entire result uses the active OMP theme's `muted` text color.

## Timing rules

- Timing starts when OMP accepts a request.
- Automatic continuations do not reset the timer.
- Durations are rounded to the nearest second and shown as seconds, minutes, or hours.
- A new request clears the previous result before the agent starts.

> [!NOTE]
> The result appears only when the active OMP mode provides UI widgets.

## Optional webhook notifications

Webhook delivery is off by default. Configure all required values in the environment that starts OMP:

| Variable | Meaning |
| --- | --- |
| `OMP_NOTIFY_ENABLED` | Enable with `1`, `true`, `yes`, or `on`. Default: disabled. |
| `OMP_NOTIFY_URL` | Full gateway endpoint URL, normally `https://<worker>.<account>.workers.dev/hook`. |
| `OMP_NOTIFY_TOKEN` | Bearer token accepted by the gateway; use the same value as its `INBOUND_SECRET`. |

```bash
export OMP_NOTIFY_ENABLED=true
export OMP_NOTIFY_URL=https://cf-notify-gateway.example.workers.dev/hook
export OMP_NOTIFY_TOKEN='replace-with-a-long-random-secret'
omp
```

The timer freezes one result snapshot when the logical main-session task settles. Automatic continuations (`agent_end.willContinue`) remain part of the same task. The fixed threshold compares the original millisecond duration, so `59999` ms is suppressed and `60000` ms is delivered. Completion, failure, and cancellation use the same threshold.
The 60-second notification threshold is fixed and cannot be lowered or raised through configuration.


The title is the owning session's current title at settlement and is not rewritten; if OMP has no title, network delivery is safely suppressed. The directory is captured with the task timer. The webhook request has a 10-second total timeout, including response-body reading. Delivery runs outside the task settlement path; timeout, network, gateway, and logging failures cannot change the task result or remove the local timer UI.

The plugin sends `POST` JSON with this versioned shape:

```json
{
  "schemaVersion": 1,
  "eventId": "<unique-id>",
  "event": "task.finished",
  "source": "omp",
  "title": "Current session title",
  "directory": "/work/project",
  "durationMs": 60000,
  "status": "completed"
}
```

`status` is `completed`, `failed`, `cancelled`, or `unknown`. `completed` means the OMP agent loop ended normally; it does not assert that a build, test suite, or other command succeeded.

### Supported OMP modes

- OMP 18.1.19 TUI main sessions are identified by their external interactive-input lifecycle, including cancellation paths.
- RPC, headless print/JSON, ACP, and direct SDK sessions deliver only after OMP's main-only `session_stop` confirms identity. A fresh session's cancellation may not emit that hook and is deliberately suppressed.
- Task subagents never receive main-session identity confirmation and do not notify. The plugin does not infer identity from UI availability, PID, or directory.

[`cf-notify-gateway`](https://github.com/qiyi71w/omp-task-timer/tree/main/cf-notify-gateway) is the matching standalone Cloudflare Worker gateway for Discord, Telegram, or both.

## Manage the plugin

Update:

```bash
omp plugin upgrade omp-task-timer
```

Remove:

```bash
omp plugin uninstall omp-task-timer
```

## Local development

```bash
git clone https://github.com/qiyi71w/omp-task-timer.git
cd omp-task-timer
omp plugin link .
```

Restart OMP, then run any task in the TUI to check the extension. The plugin ships two TypeScript runtime files and has no runtime dependencies. Run `bun test` for the focused behavior suite.

## Compatibility

Tested against the local OMP 18.1.19 extension lifecycle.
