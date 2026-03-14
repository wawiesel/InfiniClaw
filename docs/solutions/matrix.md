# Matrix Solutions

## Registering a new account on the private homeserver

**Prerequisites:** `conduwuit-ctl` must run on the Conduwuit host (Poseidon). Operators on other ships run steps 2–4 via SSH. See `docs/solutions/conduwuit.md` for snapshot issues that block registration.

**Steps:**
```bash
# 1. Generate token and password (run on any ship)
TOKEN=$(openssl rand -hex 16)
PASS=$(openssl rand -base64 24 | tr '+/' '-_' | head -c 32)

# 2. Enable registration (run on Poseidon, or ssh wawiesel@Poseidon)
conduwuit-ctl enable-registration "$TOKEN"

# 3. Register
curl -s -X POST "https://matrix.a-gis.org/_matrix/client/v3/register" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"<name>\",\"password\":\"$PASS\",
       \"auth\":{\"type\":\"m.login.registration_token\",\"token\":\"$TOKEN\"}}"
# Response: {"access_token":"...","user_id":"@<name>:a-gis.org","device_id":"..."}

# 4. Disable registration (run on Poseidon)
conduwuit-ctl restart

# 5. Save credentials to secrets/operator/<name>-matrix.json and push
```

## Inviting and joining an account to rooms

Room IDs must be URL-encoded in the path (`!` → `%21`, `:` → `%3A`). Room IDs are in `operator/intercom.json` and `operator/operator-matrix.json`.

```bash
# Invite (use an existing room member's token)
curl -s -X POST "https://matrix.a-gis.org/_matrix/client/v3/rooms/<encoded-room-id>/invite" \
  -H "Authorization: Bearer <member-token>" \
  -H "Content-Type: application/json" \
  -d '{"user_id": "@<name>:a-gis.org"}'

# Accept (use the new account's token)
curl -s -X POST "https://matrix.a-gis.org/_matrix/client/v3/rooms/<encoded-room-id>/join" \
  -H "Authorization: Bearer <new-token>" \
  -H "Content-Type: application/json" \
  -d '{}'
```

Use intercom account tokens (from `operator/intercom.json`) to invite into rooms they already occupy.

## Element Desktop doesn't render math

**Problem:** LaTeX / math expressions in bot messages don't render in Element Desktop.

**Cause:** The `feature_latex_maths` lab is disabled by default.

**Fix:** Add to Element's config file (location varies by OS — check Element docs or `--help`):
```json
{
  "show_labs_settings": true,
  "features": {
    "feature_latex_maths": true
  }
}
```
Restart Element. Enables rendering of incoming `data-mx-maths` and LaTeX input in the composer (`$...$` and `$$...$$`).

---

## Invite fails: "You must be joined in the room you are trying to invite from"

**Cause:** The account you're using to invite is not a member of that room.

**Fix:** Use a different account that is already in the room. Intercom accounts are each in one room — use the right one, or use the operator/captain account if they're in all rooms.

---

## Setting up a loudspeaker account for fleet command output

**Problem:** All ships reply to `!` commands using their own per-room intercom accounts. When multiple ships reply, each uses a different sender — messy and inconsistent.

**Solution:** Create a single `@loudspeaker` Matrix account. All ships authenticate as loudspeaker and prefix replies with `[SHIPNAME]`. This gives a uniform sender for all fleet command output.

**Steps:**
1. Register `@loudspeaker` on the homeserver (see registration steps above)
2. Invite and join it to all intercom rooms (bridge, engineering, astrometrics)
3. Save credentials to `secrets/operator/loudspeaker-matrix.json`:
   ```json
   { "homeserver": "https://matrix.a-gis.org", "username": "@loudspeaker:a-gis.org", "password": "...", "accessToken": "...", "deviceId": "..." }
   ```
4. Push. Relay loads loudspeaker on startup via `loadLoudspeakerConfig()` and uses it in `reply()` and `threadReply()`.

**Notes:**
- Loudspeaker credentials are shared fleet-wide. All ships use the same account simultaneously — this is intentional.
- Intercom accounts remain for sending `!` commands into rooms; loudspeaker is for replies only.
