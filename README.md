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

Restart OMP, then run any task in the TUI to check the extension. The package ships one TypeScript file and has no runtime dependencies.

## Compatibility

Tested with OMP 18.1.11.
