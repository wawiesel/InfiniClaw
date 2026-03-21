# 23 — Providers

> **Status:** Future design. The current bot runtime assumes one provider family for persistent main and branch brains. This document defines a provider-neutral model for future work.

## Goal

InfiniClaw should treat provider choice as a runtime capability decision, not a hard architectural dependency.

The system should be able to say:

- This provider can run a persistent main brain.
- This provider can run lobes only.
- This provider can resume a session but cannot branch.
- This provider can branch by native fork or by copy-and-resume.

The system should not assume that every provider can do every job.

## Core Principles

- **Capability over brand.** Main brain, branch brain, and lobe are behavioral roles. Provider names are implementation details.
- **Explicit session IDs always.** Automation must never rely on "last session", pickers, or current-directory inference.
- **Fork is semantic, not vendor-specific.** A provider satisfies branch capability if it can create an independent child session from a known parent session. Native fork and copy-and-resume both qualify.
- **Graceful degradation.** Missing provider capabilities must disable features cleanly instead of leaving the bot in a contradictory prompt state.
- **Different brain types may use different providers.** A bot may run one provider for the main brain and another for lobes.
- **Provider state is isolated.** Session stores, auth state, and caches must be separated by provider family.

## Terms

| Term | Meaning |
|------|---------|
| **Provider** | An agent runtime family used to execute bot work |
| **Adapter** | The host-side contract that translates InfiniClaw behavior into provider-specific CLI or SDK calls |
| **Session** | Provider-owned conversation and tool state identified by an explicit session ID |
| **Fork** | Create a new child session from a parent session while preserving parent continuity |
| **Copy-and-resume** | Start a new session from copied parent context and continue independently; counts as fork if parent and child do not overwrite each other |
| **No-branch mode** | Bot runtime mode where the active main provider cannot fork sessions, so branch brains are disabled |

## Provider Capabilities

Providers advertise capabilities rather than a single "type" flag.

| Capability | Meaning | Needed for |
|------------|---------|------------|
| `runHeadless` | Can run unattended from the host without interactive selection UIs | Main, branch, lobe |
| `resumeSession` | Can continue a known session using an explicit session ID | Main, branch |
| `forkSession` | Can create an independent child session from a known parent session ID | Branch |
| `structuredStream` | Can emit machine-readable progress and final output events | Main, branch preferred |
| `textStream` | Can emit continuous text output suitable for relay streaming | Main, branch fallback |
| `toolUse` | Can call the host tool surface during a session | Main, branch |
| `oneShotExec` | Can execute an isolated task without persistent session state | Lobe |
| `modelSelect` | Can choose model per run or session | Main, branch, lobe |

`forkSession` is a semantic capability. A provider may satisfy it with:

- native session fork
- explicit copy of parent context into a new child session

The acceptance test is behavioral: the child starts with parent context, receives a new explicit session ID, and no later child turns mutate the parent session.

## Brain Contracts

### Main Brain

Main brain requires:

- `runHeadless`
- `resumeSession`
- `toolUse`
- at least one of `structuredStream` or `textStream`

Main brain does not require `forkSession`.

### Branch Brain

Branch brain requires:

- all main-brain capabilities
- `forkSession`

Branch brain is optional. A provider that cannot fork sessions may still be a valid main-brain provider if the runtime enters no-branch mode.

### Lobe

Lobe requires:

- `oneShotExec`
- output capture

Lobes do not require persistent sessions or fork support.

## No-Branch Mode

When the active main-brain provider does not support `forkSession`, the bot runs in no-branch mode.

No-branch mode rules:

- `{{branch}}` signals in bot output are ignored by the relay (signal handler returns early)
- relay-side branch requests are rejected defensively if one is somehow queued anyway
- prompts must not instruct the main brain to branch "for all real work"
- dispatch limits must not force the bot to output branch signals that will be ignored
- the bot may still use lobes, or do bounded inline work if its persona allows it

No-branch mode is a supported operating posture, not an error state.

## Session Identity

Session identity must be explicit and provider-neutral.

Each tracked session record includes:

- provider name
- explicit session ID
- bot name
- brain type
- model
- workspace identity
- creation time
- optional parent session ID

Rules:

- Every automated resume uses an explicit session ID.
- Every automated fork uses an explicit parent session ID.
- Child branch sessions receive their own explicit child session ID.
- Parent and child IDs are both preserved for metrics and recovery.
- The system never infers session identity from "most recent".

## Provider Configuration

Provider configuration is capability-first.

Example shape:

```yaml
brain:
  main:
    provider: codex
    model: gpt-5.4
  branch:
    enabled: false
  lobe:
    default_provider: codex
    allowed_providers:
      - codex
      - claude
      - gemini
      - ollama
```

Configuration principles:

- main, branch, and lobe may be configured independently
- branch may be disabled explicitly
- branch may also be disabled implicitly if the chosen provider lacks `forkSession`
- capability checks happen at startup and on provider switches, not only at call time

## Prompt and Tool Policy

Prompts must reflect actual runtime capability.

Examples:

- If branch is disabled, the main brain should be told to use lobes or bounded inline work instead of branching.
- If branch is enabled, the branch tool may be exposed and the main brain may be instructed to stay responsive by delegating.
- Persona policy must not assume one universal dispatch model across all providers.

Tool exposure follows runtime capability, not documentation convention.

## Authentication and State

Each provider maintains its own auth and session state.

Requirements:

- no shared session directory across providers
- no provider reads another provider's auth files as part of normal operation
- provider-specific caches are isolated
- provider swap does not reuse incompatible session state

This prevents "resume worked on the wrong provider" class failures.

## Metrics

Metrics must separate provider capability from provider selection.

Track:

- provider family
- model
- brain type
- branch enabled or disabled
- branch rejection count due to capability
- branch success rate where supported
- resume recovery rate by provider

This allows the fleet to answer:

- Which providers are stable as main brains?
- Which providers are stable only as lobes?
- Does no-branch mode preserve responsiveness?

## Migration Phases

### Phase 1

Introduce provider adapters and capability declarations.

### Phase 2

Support provider-neutral main brains and lobes.

### Phase 3

Support no-branch mode as a first-class operating mode.

### Phase 4

Enable branch brains only for providers that satisfy `forkSession`.

### Phase 5

Consider cross-provider branching or summary-handoff branching as a separate design problem.

Cross-provider branch handoff is out of scope for the first provider-generalization pass.

## Verification

1. **Explicit resume identity** — Restart a bot and resume by explicit session ID.
   *Check:* The resumed brain continues the correct session without consulting "most recent" state.

2. **No-branch mode** — Configure a main provider without `forkSession`.
   *Check:* Branch tools are unavailable, prompts do not demand branching, and the bot remains operational.

3. **Fork semantics** — Configure a provider with `forkSession`.
   *Check:* A child session starts with parent context, receives a distinct session ID, and parent continuity is preserved after child completion.

4. **Lobe independence** — Use a lobe-only provider.
   *Check:* Lobe execution works without persistent session state.

5. **Provider swap isolation** — Change a bot from one provider family to another.
   *Check:* Old session or auth state is not reused incorrectly.
