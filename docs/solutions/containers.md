# Container & Process Management Solutions

## Outbound HTTPS fails from Podman containers

**Problem:** Podman containers can't make HTTPS requests. Error: `ERR_SSL_PACKET_LENGTH_TOO_LONG`.

**Cause:** A port forwarding rule on the host (e.g. NAS → host:443 for Matrix) intercepts the container's outbound port 443 traffic on the default bridge network.

**Fix:** Use host networking:
```bash
podman build --network host ...
# or add --network host to container run args
```

---

## New bot fails to start — pm2 not found

**Problem:** Bot fails to start, errors reference pm2 not found or wrong path.

**Cause:** `service.ts` resolves pm2 from `node_modules/.bin/pm2`, not the system PATH. If pm2 is only installed globally, it won't be found.

**Fix:**
```bash
npm install pm2 --save-dev
```

---

## Mystery bot respawns — duplicate processes, doubled Matrix messages

**Problem:** After stopping a bot, it immediately respawns. Killing the process does nothing. Two copies are running and processing every message twice.

**Cause:** A previous process manager (e.g. macOS launchd with `KeepAlive: true`) was never removed when migrating to PM2. The old launch agent fights the new one forever.

**Diagnosis:**
```bash
# macOS
launchctl list | grep infiniclaw

# Linux
systemctl list-units | grep infiniclaw
```

**Fix:** Remove the old process manager's config and unload it:
```bash
# macOS
launchctl unload ~/Library/LaunchAgents/com.infiniclaw.<bot>.plist
rm ~/Library/LaunchAgents/com.infiniclaw.<bot>.plist
```

**Rule:** When migrating process managers, always remove the old config first.

---

## `npm run cli start` starts all bots, not just the one named

**Problem:** Running `npm run cli start <bot>` starts more bots than expected.

**Cause:** The CLI starts all bots in `fleet.json` assigned to this machine, not just the named one.

**Fix:** Edit `fleet.json` to set unwanted bots to `dismissed` before starting, or stop the extras after:
```bash
npm run cli stop <bot>
```
