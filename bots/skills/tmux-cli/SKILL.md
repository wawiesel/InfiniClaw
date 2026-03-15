---
name: tmux-cli
description: Communicate with CLI agents or long-running scripts in other tmux panes or windows. Use when coordinating parallel CLI work, launching subordinate agents, or checking on existing tmux-managed processes.
---

# tmux-cli

## Goal

Use the `tmux-cli` command to launch shells, send commands, and capture output from other tmux panes or windows without switching away from your current work.

## When to use it

- Coordinating multiple CLI agents in parallel
- Launching a safe shell before running a long or fragile command
- Checking progress from another pane without attaching
- Interrupting or cleaning up a hung subprocess running under tmux

## Prerequisites

- `tmux` must be installed
- `tmux-cli` must be available on `PATH`

If `tmux-cli` is missing, install it with:

```bash
uv tool install claude-code-tools
```

## Rules

- Always launch a shell first, preferably `zsh`
- Save the pane or window identifier returned by `launch`
- Capture output before sending more input if state is unclear
- Use `wait_idle` instead of blind polling when a process is still running
- Do not kill your own active pane

## Safe workflow

1. Launch a shell:

```bash
tmux-cli launch "zsh"
```

2. Run the target command in that pane:

```bash
tmux-cli send "python3 script.py" --pane=<pane-id>
```

3. Wait for output to settle:

```bash
tmux-cli wait_idle --pane=<pane-id>
```

4. Inspect the result:

```bash
tmux-cli capture --pane=<pane-id>
```

5. Clean up when done:

```bash
tmux-cli kill --pane=<pane-id>
```

## Core commands

- `tmux-cli status`
- `tmux-cli list_panes`
- `tmux-cli launch "zsh"`
- `tmux-cli send "..." --pane=<pane-id>`
- `tmux-cli capture --pane=<pane-id>`
- `tmux-cli wait_idle --pane=<pane-id>`
- `tmux-cli interrupt --pane=<pane-id>`
- `tmux-cli escape --pane=<pane-id>`
- `tmux-cli kill --pane=<pane-id>`

## Remote mode

When running outside tmux, `tmux-cli` manages a dedicated remote session. Useful commands there are:

- `tmux-cli list_windows`
- `tmux-cli attach`
- `tmux-cli cleanup`
