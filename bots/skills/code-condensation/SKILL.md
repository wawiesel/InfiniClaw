---
name: code-condensation
description: Analyze codebase complexity with lizard and systematically refactor high-CCN functions. Run on-demand for targeted simplification.
---

# Codebase Simplify

Systematically reduce complexity in the codebase using cyclomatic complexity analysis.

## Prerequisites

Install lizard (first run only):
```bash
pip3 install --user lizard
```

## Workflow

### 1. Analyze complexity

```bash
~/.local/bin/lizard /workspace/extra/InfiniClaw/src/ -s cyclomatic_complexity 2>&1 | tail -30
```

The "Warnings" section shows high-CCN functions (CCN > 15 = refactor candidate).

### 2. Target high-CCN functions

Common simplification patterns:
- **Switch statements**: Extract each case into a separate handler function
- **Nested conditionals**: Extract to guard clauses or helper functions
- **Long functions**: Split into smaller, single-responsibility functions
- **Dead code**: Remove unused imports, exports, and no-op functions

### 3. Quick wins first

Before tackling complex functions, look for dead code:
- Unused imports: `grep -rh "from '\./\|from 'nanoclaw" src/ | sort | uniq`
- Unused exports: Compare export list against actual imports
- No-op functions: Functions that only log or return without side effects

### 4. Make focused commits

Each commit should:
- Fix one type of issue or refactor one function
- Include a clear commit message explaining the change
- Build successfully before committing

### 5. Push via IPC

Container doesn't have SSH keys. Write a git_push task:
```bash
echo '{"type":"git_push","remote":"origin","branches":["main"]}' > /workspace/ipc/tasks/git-push-$(date +%s).json
```

## Example session

```bash
# Install lizard
pip3 install --user lizard

# Find complex functions
~/.local/bin/lizard /workspace/extra/InfiniClaw/src/ -s cyclomatic_complexity 2>&1 | tail -30

# Read the high-CCN function
# Refactor it
# Build and test
cd /workspace/extra/InfiniClaw && npm run build

# Commit
git add <files> && git commit -m "simplify: ..."

# Push via IPC
echo '{"type":"git_push","remote":"origin","branches":["main"]}' > /workspace/ipc/tasks/git-push-$(date +%s).json
```
