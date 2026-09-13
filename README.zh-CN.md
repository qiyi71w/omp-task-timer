<div align="center">

# OMP Task Timer

在输入框上方显示 [Oh My Pi](https://github.com/can1357/oh-my-pi) 任务的耗时和结束状态。

[English](./README.md) | [简体中文](./README.zh-CN.md)

[![npm version](https://img.shields.io/npm/v/omp-task-timer?style=flat-square)](https://www.npmjs.com/package/omp-task-timer)
[![npm downloads](https://img.shields.io/npm/dm/omp-task-timer?style=flat-square)](https://www.npmjs.com/package/omp-task-timer)
[![license](https://img.shields.io/npm/l/omp-task-timer?style=flat-square)](./LICENSE)

</div>

`omp-task-timer` 会在 OMP 输入框上方显示一行任务耗时和结束状态。下一条请求开始时，这行结果会自动清除。

```text
✓ Task finished · 12s
```

## 安装

```bash
omp plugin install omp-task-timer
```

> [!IMPORTANT]
> OMP 会在启动时加载扩展。安装、更新或移除本包后，请重启 OMP。

## 显示结果

| 结束状态 | 显示内容 |
| --- | --- |
| 正常完成 | `✓ Task finished · 12s` |
| 运行失败 | `✗ Task failed · 12s` |
| 按 `Esc` 中断 | `■ Task interrupted · 12s` |

整行结果使用当前 OMP 主题的 `muted` 文字颜色。

## 计时规则

- OMP 接受请求时开始计时。
- OMP 自动继续执行时不会重置计时。
- 耗时四舍五入到秒，并按秒、分钟或小时显示。
- 新请求会在代理开始运行前清除上一次结果。

> [!NOTE]
> 只有当前 OMP 模式支持 UI 组件时才会显示结果。

## 可选 Webhook 通知

Webhook 默认关闭。请在启动 OMP 的同一环境中配置所有必需变量：

| 变量 | 含义 |
| --- | --- |
| `OMP_NOTIFY_ENABLED` | 设为 `1`、`true`、`yes` 或 `on` 时启用；默认关闭。 |
| `OMP_NOTIFY_URL` | 网关完整地址，通常为 `https://<worker>.<account>.workers.dev/hook`。 |
| `OMP_NOTIFY_TOKEN` | 网关接受的 Bearer token；必须与网关的 `INBOUND_SECRET` 相同。 |

```bash
export OMP_NOTIFY_ENABLED=true
export OMP_NOTIFY_URL=https://cf-notify-gateway.example.workers.dev/hook
export OMP_NOTIFY_TOKEN='replace-with-a-long-random-secret'
omp
```

主会话任务逻辑结算时，计时器冻结唯一一份结果快照。自动续轮（`agent_end.willContinue`）仍属于同一任务。固定阈值直接比较原始毫秒值：`59999` ms 不发送，`60000` ms 发送。完成、失败和取消统一使用该阈值。
通知阈值固定为 60 秒，不能通过配置调低或调高。


标题直接读取结算时所属会话的当前标题，不调用模型改写；若 OMP 尚无标题，则安全抑制网络发送。目录与计时任务一同捕获。Webhook 请求整体最多 10 秒，包括响应体读取。发送不占用任务结算路径；超时、网络、网关或日志异常都不会改变主任务结果，也不会破坏原有本地 timer UI。

插件发送以下版本化 `POST` JSON：

```json
{
  "schemaVersion": 1,
  "eventId": "<unique-id>",
  "event": "task.finished",
  "source": "omp",
  "title": "当前会话标题",
  "directory": "/work/project",
  "durationMs": 60000,
  "status": "completed"
}
```

`status` 可为 `completed`、`failed`、`cancelled` 或 `unknown`。`completed` 只表示 OMP agent loop 正常结束，不代表构建、测试或其他命令一定成功。

### 支持的 OMP 模式

- OMP 18.1.19 的 TUI 主会话通过外部交互输入生命周期确认身份，包含取消路径。
- RPC、headless print/JSON、ACP 和直接 SDK 会话仅在 OMP 的主会话专属 `session_stop` 确认身份后发送。新会话的取消路径可能不触发该 hook，因此会安全抑制。
- task 子代理得不到主会话身份确认，不会发送通知。插件不会用 UI 可用性、PID 或目录猜测身份。

配套的独立 Cloudflare Worker 网关 [`cf-notify-gateway`](https://github.com/qiyi71w/omp-task-timer/blob/main/cf-notify-gateway/README.zh-CN.md) 可启用 Discord、Telegram 或两者。

## 管理插件

更新：

```bash
omp plugin upgrade omp-task-timer
```

移除：

```bash
omp plugin uninstall omp-task-timer
```

## 本地开发

```bash
git clone https://github.com/qiyi71w/omp-task-timer.git
cd omp-task-timer
omp plugin link .
```

重启 OMP 后，在 TUI 中运行任意任务即可查看效果。插件包含两个 TypeScript 运行时文件，没有运行时依赖。使用 `bun test` 运行聚焦行为测试。

## 兼容性

已按本机 OMP 18.1.19 扩展生命周期完成测试。
