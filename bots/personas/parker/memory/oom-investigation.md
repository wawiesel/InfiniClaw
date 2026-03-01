# OOM Investigation

Last updated: 2026-03-01

## Root Cause Analysis (Completed)

### Memory Architecture
- **Container memory limit**: 6144MB (set via podman)
- **Host heap watchdog**: 1536MB threshold, checks every 60 seconds
- **In-container watchdog**: NONE -- containers are unprotected from OOM
- **Session size cap**: 2MB (Captain confirmed this should NOT cause OOM)

### Key Findings
1. No in-container memory watchdog means containers can hit the 6144MB cgroup limit and get OOM-killed with no warning or graceful handling.
2. The host-side heap watchdog (1536MB / 60s interval) only monitors the host process, not individual containers.
3. OOM restart loops are possible: a bot that OOMs can re-OOM immediately on restart if the conditions that caused the OOM persist (e.g., large context still loaded).
4. Session size is capped at 2MB and is NOT a likely OOM contributor (Captain correction).

## Captain-Approved Recommendations

Captain approved recommendations 1 through 3 (out of 4):

1. **OOM backoff logic** -- Wait 30-60s before restarting after OOM, stop after 3 consecutive OOMs to break restart loops.
2. **In-container memory watchdog** -- Monitor memory usage inside each container and take action (warn, shed load, graceful restart) before hitting the cgroup limit.
3. **Session size guard or similar** -- (Approved, but note Captain's correction: session size is capped at 2MB and should not cause OOM. Adjust approach accordingly -- may need to guard against other memory sources instead.)
4. *(Not approved / deferred)* -- Fourth recommendation was not approved in this round.

## Task Status

| Status | Task |
|--------|------|
| in_progress | Add OOM backoff logic (wait 30-60s, stop after 3 consecutive OOMs) |
| in_progress | Implement in-container memory watchdog |
| in_progress | Add session size guard or similar (recommendation 3, adjusted per Captain's 2MB cap note) |
| pending | Set up scheduled health checks (Phase 2) |
| completed | Error rates in check.sh (errors_per_hr, ooms_per_hr, restarts_per_hr, uptime_hrs) |

## Captain Corrections

- Session size is capped at 2MB. Do NOT treat session size as an OOM vector. Adjust recommendation 3 accordingly -- focus on other memory consumers (tool output buffering, large file reads, accumulated context, etc.).

## Open Questions

- What was recommendation 4 that was NOT approved? (Need to check session transcript if context is needed.)
- What are the actual primary memory consumers that push containers toward the 6144MB limit?
- Where should the in-container watchdog be implemented -- in nanoclaw source or as a standalone sidecar script?
