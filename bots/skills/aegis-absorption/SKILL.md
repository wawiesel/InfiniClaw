---
name: aegis-absorption
description: Analyze arbitrary code and absorb its key functionality into AEGIS as reusable functions. Use when encountering useful logic in prototypes, scripts, skills, external repos, or one-off code that should become part of the AEGIS library.
---

# AEGIS Absorption

## Goal

Find useful code wherever it lives and bring the essential functionality into AEGIS as clean, tested, reusable functions.

## Process

1. **Identify the code** — prototype, script, skill inline logic, external repo, or one-off solution
2. **Extract the essence** — what is the core functionality? Strip away context-specific wiring.
3. **Check AEGIS** — does something similar already exist? Extend rather than duplicate.
4. **Implement in AEGIS** — write the function with clear API, docstring, type hints
5. **Write tests** — every absorbed function needs tests
6. **Update callers** — rewrite the original code to use the new AEGIS function

## AEGIS location

- Source: `~/2025-AEGIS/source/`
- Tests alongside source

## What to absorb

- Logic that appears in 2+ places (skills, scripts, prototypes)
- Complex algorithms buried in a one-off script
- Prototype code that proved its value
- External library wrappers that add project-specific behavior
- File format parsers, data transformers, API clients

## What NOT to absorb

- Glue code that's specific to one caller
- Configuration or constants
- Code that's simpler inline than as a function call

## Rules

- **Extract, don't copy** — understand the logic, rewrite it cleanly
- **Test first** — write the test before or alongside the function
- **One function, one job** — don't create god functions
- **Document the source** — note where the logic came from in the commit message
