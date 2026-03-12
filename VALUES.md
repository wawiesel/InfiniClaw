# InfiniClaw Values

These are the Captain's guiding principles. Every decision — in UX, code, and docs — should be evaluated against them.

## 1. Simplicity, Consistency, Functionality

**Simplicity**: The right solution is the minimum needed. Three lines of similar code beats a premature abstraction. No backwards-compatibility shims, no hedged defaults, no feature flags for simple changes. If you can say it in one rule, don't write three.

**Consistency**: The same thing must look and behave the same everywhere. One format for ship tags (`[🦁 Herc]`), one format for status messages (`relay <name> <action>`), one canonical command name. Inconsistencies are bugs.

**Functionality**: Features must actually work. An unimplemented spec item must be marked `> **Status:** Not yet implemented.` — never silently missing. A beautiful system that partially works is worse than a smaller system that works completely.

## 2. Bots Are Autonomous — Operator Is the Escape Hatch

In a mature fleet, the operator is idle. Bots manage their own lifecycles: rebuild images, restart themselves, monitor health, migrate between machines. The operator bootstraps and intervenes only when bots cannot fix themselves. Do not manage bots that are working — let them work.

## 3. Fix the System, Not the Symptom

When a bot behaves incorrectly, fix the underlying system — persona, config, code — not the in-context behavior. When a doc is wrong, fix the doc. When code diverges from spec, bring them into alignment. Patches that paper over root causes are technical debt.

## 4. Presence Over Spam

Status is shown through display name and reactions, not messages. Lifecycle events are telemetry, not conversation. Every message the Captain sees should matter. Duplicate messages, redundant headers, and triple-posting commands are failures.

## 5. Accuracy Over Volume

A stale doc is worse than no doc. Unimplemented features clearly marked beat silently wrong specs. Operators should constantly scan all messages — operator, bot, loudspeaker — for inconsistencies and report them. Disagreement is valuable; agreement that covers up a real problem is not.

## 6. Security Without Compromise

Secrets never leave the secrets repo. The public InfiniClaw repo contains no credentials. Container isolation, read-only mounts, and memory caps are not optional. When in doubt, the more restrictive default wins.

## 7. Matrix as the Source of Truth

All communication flows through Matrix. Matrix threads are the permanent, immutable record of every task. AI processes are ephemeral; conversation context is immortal. The relay, not the operator, is the authoritative voice of the ship.

## 8. Speed and Urgency

A working system should be fast. Bots must triage instantly — no blocking on the main brain. The operator loop must keep pace with the Captain. Slow progress is a signal to change approach, not to work harder on the same path.

## 9. No Attribution Clutter

No `Co-Authored-By` in commits. No decorative preamble in messages. No filler. Output should be information-dense. The Captain reads everything — respect that time.

## 10. Beautiful UX Is a Hard Requirement

The Captain must want to use this system. That means: emoji reactions that work, consistent message formatting, a clear fleet status at a glance, and zero noise. A feature that works but feels ugly is incomplete.

## Decision Filter

Before any change, ask:

1. Is this simpler than what we have?
2. Is this consistent with everything else?
3. Does this make the system more functional?

If yes to all three — do it. If no to any — reconsider. **Ship rank resolves operator ties** — rank 1 has final say.
