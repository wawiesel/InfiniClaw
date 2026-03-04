---
name: prototyping
description: Create standalone code projects to demonstrate concepts, test ideas, or prove feasibility. Use when the Captain wants to explore an approach, validate a design, or build a quick proof-of-concept.
---

# Prototyping

## Goal

Build small, self-contained projects that demonstrate a concept clearly. Prototypes are disposable — they prove something works, then inform the real implementation.

## Process

1. **Clarify the question** — what exactly are we trying to prove?
2. **Create a standalone project** — own directory, own dependencies, runs independently
3. **Keep it minimal** — only what's needed to demonstrate the concept
4. **Document the finding** — what worked, what didn't, what to do next
5. **Share the result** — link or move useful code into the real project

## Where to put prototypes

```
~/prototypes/YYYY_MM_DD-description/
├── README.md       # What this proves and how to run it
├── main.py         # (or whatever language fits)
└── ...
```

## Rules

- **Standalone** — no dependencies on InfiniClaw, AEGIS, or other projects. Anyone should be able to clone and run it.
- **Minimal** — strip away everything that isn't the core question
- **Documented** — README explains what it proves and the conclusion
- **Disposable** — prototypes are not production code. Don't gold-plate them.
- **Fast** — a prototype that takes days has missed the point
