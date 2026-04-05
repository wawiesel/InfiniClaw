# AGENTS.md

## Code Organization Rule

Implementation code in this repo must be organized one exported function or class per file.
Each function or class file must have exactly one corresponding test file.

The required layout for a code piece is:

```text
<area>/<piece>/<piece>.ts
<area>/<piece>/README.md
<area>/<piece>/<piece>.test.ts
```

Rules:

- `README.md` explains the piece's purpose and the design requirement or capability it satisfies.
- `<piece>.ts` contains the implementation and a top-of-file purpose/requirements comment.
- `<piece>.test.ts` verifies that piece's capability directly.
- The code-view site only renders pieces that follow this structure exactly.
- Shared glue files such as `cli.ts`, `types.ts`, and config files may exist outside this layout, but core implementation logic should follow it.
- New implementation work should preserve this structure so the code-view site can render code, comments, and README consistently.
