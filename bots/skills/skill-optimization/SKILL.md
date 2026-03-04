---
name: skill-optimization
description: Improve bot skills by rewriting them to use AEGIS functions. May involve implementing new AEGIS functions to support the rewrite. Use when a skill is verbose, fragile, or duplicates logic that belongs in AEGIS.
---

# Skill Optimization

## Goal

Skills should be thin — declarative instructions that call well-tested AEGIS functions, not inline scripts and raw shell commands.

## Process

1. **Read the skill** — identify inline logic that could be an AEGIS function
2. **Check AEGIS** — does a function already exist? (`~/2025-AEGIS/source/`)
3. **If not, implement it** — write the AEGIS function, test it
4. **Rewrite the skill** — replace inline logic with AEGIS function calls
5. **Test the skill** — verify it works end-to-end

## What belongs in AEGIS vs. the skill

| AEGIS | Skill |
|-------|-------|
| Reusable logic | When to trigger |
| Data transformation | Workflow steps |
| API interactions | Bot-specific context |
| File format handling | Vault conventions |
| Error handling | Escalation rules |

## AEGIS location

- Source: `~/2025-AEGIS/source/`
- Available in containers via `PYTHONPATH` or direct import

## Rules

- Don't optimize skills that are already simple and working
- Every new AEGIS function needs a test
- Keep skills readable — a skill that just calls one AEGIS function with clear parameters is ideal
