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

重启 OMP 后，在 TUI 中运行任意任务即可查看效果。本包只有一个 TypeScript 扩展文件，没有运行时依赖。

## 兼容性

已在 OMP 18.1.11 上完成测试。
