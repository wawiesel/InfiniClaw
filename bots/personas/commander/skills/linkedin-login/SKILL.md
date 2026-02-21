---
name: linkedin-login
description: Access LinkedIn via the Captain's browser. LinkedIn blocks headless/containerized browsers, so the Captain must start Chrome with remote debugging on his Mac and you connect to it.
allowed-tools: Bash(agent-browser:*)
---

# LinkedIn Access

LinkedIn detects and blocks headless browsers inside containers. You **cannot** browse LinkedIn directly. Instead, the Captain starts Chrome on his Mac and you connect to it remotely via a socat relay.

## How it works

macOS prevents Chrome from binding its debug port to all interfaces — it only listens on `localhost`. A `socat` relay on port 9223 forwards container traffic to Chrome's port 9222.

1. Ask the Captain to run these two commands on his Mac (if not already running):

```bash
# Start Chrome with remote debugging
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-debug

# Start socat relay (in a separate terminal)
socat TCP-LISTEN:9223,fork,reuseaddr TCP:localhost:9222
```

2. Connect from the container:

```bash
agent-browser connect host.containers.internal:9223
```

3. Then browse normally:

```bash
agent-browser open https://www.linkedin.com/notifications/
agent-browser snapshot -i
```

The Captain's real Chrome session has LinkedIn auth — no separate login needed.

## When you're done

```bash
agent-browser close
```

Tell the Captain he can close Chrome and the socat relay (or leave them running for later).

## If connection fails

Tell the Captain: "I need Chrome running with `--remote-debugging-port=9222` and the socat relay (`socat TCP-LISTEN:9223,fork,reuseaddr TCP:localhost:9222`) to access LinkedIn. Can you start them?"
