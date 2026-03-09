# Matrix Solutions

## Registering a new account on the private homeserver

**Prerequisites:** Access to Poseidon (runs conduwuit). See `docs/solutions/conduwuit.md` for snapshot issues that block registration.

**Steps:**
```bash
# 1. Generate token and password
TOKEN=$(openssl rand -hex 16)
PASS=$(openssl rand -base64 24 | tr '+/' '-_' | head -c 32)

# 2. Enable registration
conduwuit-ctl enable-registration "$TOKEN"

# 3. Register
curl -s -X POST "https://matrix.a-gis.org/_matrix/client/v3/register" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"<name>\",\"password\":\"$PASS\",
       \"auth\":{\"type\":\"m.login.registration_token\",\"token\":\"$TOKEN\"}}"
# Response: {"access_token":"...","user_id":"@<name>:a-gis.org","device_id":"..."}

# 4. Disable registration
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

## Invite fails: "You must be joined in the room you are trying to invite from"

**Cause:** The account you're using to invite is not a member of that room.

**Fix:** Use a different account that is already in the room. Intercom accounts are each in one room — use the right one, or use the operator/captain account if they're in all rooms.
