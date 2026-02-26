# Engineering Spec: Pre-compile TypeScript in Image (Performance Fix)

**Author**: Architect
**Date**: 2026-02-26
**Status**: Draft
**Priority**: High (Performance)

---

## Summary

All three bot containers (engineer, commander, architect) currently recompile TypeScript from source on every container startup, adding ~10-15 seconds to every message. The Dockerfiles already pre-compile TypeScript during image build (`npm run build` → `/app/dist/`), but the entrypoint ignores this and runs `npx tsc` at runtime. This spec eliminates the redundant runtime compilation by using the pre-built artifacts.

---

## Problem

### Current Behavior
Each Dockerfile runs `RUN npm run build` which compiles TypeScript from `/app/src/` to `/app/dist/` during image build. However, the entrypoint script ignores this pre-built output:

```bash
#!/bin/bash
set -e
cd /app && npx tsc --outDir /tmp/dist 2>&1 >&2
ln -s /app/node_modules /tmp/dist/node_modules
chmod -R a-w /tmp/dist
cat > /tmp/input.json
node /tmp/dist/index.js < /tmp/input.json
```

This recompiles TypeScript from scratch at container startup, on every single message.

### Impact
- **10-15 second latency** added to every bot response
- Wasted CPU cycles
- Degraded user experience
- Unnecessary complexity (symlinks, temp directory management)

### Root Cause
Historical artifact — the entrypoint was likely written before `npm run build` was added to the Dockerfile, and never updated when the pre-compilation step was introduced.

---

## Solution

### Change the Entrypoint Script
Replace the compilation-at-runtime approach with direct execution of pre-built artifacts:

```bash
#!/bin/bash
set -e
cat > /tmp/input.json
node /app/dist/index.js < /tmp/input.json
```

This:
- Eliminates `npx tsc` at runtime
- Eliminates temp directory creation
- Eliminates symlink creation
- Eliminates `chmod` step
- Uses pre-built `/app/dist/` directly

### Why This Is Safe
1. **Pre-built artifacts already exist**: `RUN npm run build` in the Dockerfile creates `/app/dist/`
2. **Immutable images**: If agent-runner source changes, the image must be rebuilt (already enforced by image-hash tracking in `rebuildImageIfChanged()`)
3. **Read-only by default**: Pre-built dist is owned by root, already read-only to the `node` user
4. **No runtime mutations**: The container doesn't modify source code, so recompilation is never needed

---

## Files to Change

### 1. `bots/container/engineer/Dockerfile`

**Location**: Line 68

**Old content**:
```dockerfile
RUN printf '#!/bin/bash\nset -e\ncd /app && npx tsc --outDir /tmp/dist 2>&1 >&2\nln -s /app/node_modules /tmp/dist/node_modules\nchmod -R a-w /tmp/dist\ncat > /tmp/input.json\nnode /tmp/dist/index.js < /tmp/input.json\n' > /app/entrypoint.sh \
    && chmod +x /app/entrypoint.sh
```

**New content**:
```dockerfile
RUN printf '#!/bin/bash\nset -e\ncat > /tmp/input.json\nnode /app/dist/index.js < /tmp/input.json\n' > /app/entrypoint.sh \
    && chmod +x /app/entrypoint.sh
```

---

### 2. `bots/container/commander/Dockerfile`

**Location**: Line 82

**Old content**:
```dockerfile
RUN printf '#!/bin/bash\nset -e\ncd /app && npx tsc --outDir /tmp/dist 2>&1 >&2\nln -s /app/node_modules /tmp/dist/node_modules\nchmod -R a-w /tmp/dist\ncat > /tmp/input.json\nnode /tmp/dist/index.js < /tmp/input.json\n' > /app/entrypoint.sh \
    && chmod +x /app/entrypoint.sh
```

**New content**:
```dockerfile
RUN printf '#!/bin/bash\nset -e\ncat > /tmp/input.json\nnode /app/dist/index.js < /tmp/input.json\n' > /app/entrypoint.sh \
    && chmod +x /app/entrypoint.sh
```

---

### 3. `bots/container/architect/Dockerfile`

**Location**: Line 68

**Old content**:
```dockerfile
RUN printf '#!/bin/bash\nset -e\ncd /app && npx tsc --outDir /tmp/dist 2>&1 >&2\nln -s /app/node_modules /tmp/dist/node_modules\nchmod -R a-w /tmp/dist\ncat > /tmp/input.json\nnode /tmp/dist/index.js < /tmp/input.json\n' > /app/entrypoint.sh \
    && chmod +x /app/entrypoint.sh
```

**New content**:
```dockerfile
RUN printf '#!/bin/bash\nset -e\ncat > /tmp/input.json\nnode /app/dist/index.js < /tmp/input.json\n' > /app/entrypoint.sh \
    && chmod +x /app/entrypoint.sh
```

---

## Testing Plan

### Pre-test Validation (Cid)
1. **Verify pre-built artifacts exist in current images**:
   ```bash
   podman run --rm --entrypoint ls infiniclaw-engineer:latest /app/dist/
   podman run --rm --entrypoint ls infiniclaw-commander:latest /app/dist/
   podman run --rm --entrypoint ls infiniclaw-architect:latest /app/dist/
   ```
   Expected: Should list compiled `.js` files including `index.js`

2. **Verify tsconfig.json output directory**:
   ```bash
   grep -A1 '"outDir"' $INFINICLAW_ROOT/bots/agent-runner/tsconfig.json
   ```
   Expected: `"outDir": "./dist"`

### Implementation Testing (Cid)
1. Make the three Dockerfile changes
2. Rebuild all three bot images:
   ```bash
   npm run build:images
   ```
3. Verify entrypoint script in each new image:
   ```bash
   podman run --rm --entrypoint cat infiniclaw-engineer:latest /app/entrypoint.sh
   podman run --rm --entrypoint cat infiniclaw-commander:latest /app/entrypoint.sh
   podman run --rm --entrypoint cat infiniclaw-architect:latest /app/entrypoint.sh
   ```
   Expected: Should show simplified entrypoint (no tsc, no ln, no chmod)

### Functional Testing (Architect on Holodeck)
1. **Startup time measurement**:
   - Send a simple message to Cid on holodeck
   - Measure time from message send to first response
   - Expected: Should be ~10-15 seconds faster than before
   - Tool: Add timing logs to `src/service.ts` around container execution

2. **Functional validation**:
   - Send messages requiring all bot capabilities:
     - **Cid**: Code reading, editing, writing, bash execution
     - **Johnny5**: Multi-bot coordination, message routing
     - **Architect** (self-test): File operations, spec writing
   - Expected: All operations succeed with no errors

3. **Error handling**:
   - Verify error messages are properly surfaced (not swallowed by removed stderr redirect)
   - Send a message that triggers an intentional error
   - Expected: Error message is visible in bot response

### Performance Validation (Architect)
1. Benchmark 10 sequential messages to each bot
2. Compare average response time before/after
3. Expected improvement: ~10-15 seconds per message

---

## Rollback

If issues are discovered:

1. **Immediate rollback** (no code changes needed):
   ```bash
   # Revert to previous image hashes in container-config.json
   git checkout HEAD~1 bots/container-config.json
   # Or manually restore previous image IDs
   ```

2. **Full rollback** (revert Dockerfile changes):
   ```bash
   git revert <commit-hash>
   npm run build:images
   ```

The system's image-hash tracking ensures old images remain available until explicitly garbage-collected.

---

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Pre-built artifacts missing or incomplete | Low | High | Pre-test validation confirms `/app/dist/` exists and contains `index.js` |
| Runtime errors not visible (stderr redirect removed) | Low | Medium | Functional testing includes error case validation |
| Source changes not reflected after image build | Low | Medium | Already handled by existing `rebuildImageIfChanged()` logic |
| File permission issues | Very Low | Low | Pre-built dist is owned by root, inherently read-only to `node` user |

---

## Acceptance Criteria

### Must Have
- [ ] All three Dockerfiles updated with simplified entrypoint
- [ ] All three bot images rebuild successfully
- [ ] Entrypoint scripts in new images match expected simplified version
- [ ] All bots respond to messages without errors
- [ ] Response time improved by ~10-15 seconds per message
- [ ] Error messages still surface correctly

### Should Have
- [ ] Performance benchmarks documented (before/after comparison)
- [ ] No regressions in existing bot functionality

### Nice to Have
- [ ] Container logs show reduced startup verbosity
- [ ] Documentation updated to reflect entrypoint simplification

---

## Implementation Notes for Cid

1. **Make changes in order**: engineer → commander → architect (test each before proceeding)
2. **Check git status**: All three Dockerfiles should show modifications
3. **Image rebuild**: Use `npm run build:images` or equivalent script
4. **Verify hashes**: New image hashes should appear in build output
5. **Test immediately**: Send a test message before marking complete

---

## Future Improvements (Out of Scope)

- Remove `npm run build` from Dockerfile if not used elsewhere (verify first)
- Consolidate Dockerfile entrypoint generation (all three are identical after this change)
- Consider multi-stage build optimization to reduce image size

---

**End of Spec**
