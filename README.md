# OMP Task Timer

A small [Oh My Pi](https://github.com/can1357/oh-my-pi) extension that shows how long each task ran and how it ended.

The result stays above the editor until the next request starts. It uses the active OMP theme's muted text color, so it remains visible without competing with the conversation.

## Install

```bash
omp plugin install omp-task-timer
```

Restart OMP after installation so the extension is loaded.

## Task outcomes

| Outcome | Display |
| --- | --- |
| Completed | `✓ Task finished · 12s` |
| Failed | `✗ Task failed · 12s` |
| Interrupted with `Esc` | `■ Task interrupted · 12s` |

Automatic continuations remain part of the same timer. The previous result is cleared when the next request starts.

Durations are rounded to the nearest second and formatted as seconds, minutes, or hours.

## Update or remove

```bash
omp plugin upgrade omp-task-timer
omp plugin uninstall omp-task-timer
```

Restart OMP after changing the installed plugin.

## Local development

From this repository:

```bash
omp plugin link .
```

Restart OMP, then run a normal task to exercise the extension in the TUI.

Tested with OMP 18.1.11.
