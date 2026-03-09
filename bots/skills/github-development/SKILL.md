---
name: github-development
description: GitHub-based development workflow using branches, PRs, and issues. Use when assigned a task via PR or issue — creating branches, writing code, committing, pushing, and opening PRs via `gh` CLI.
---

# GitHub Development

## Workflow

1. **Receive assignment** — operator assigns you a PR topic or issue
2. **Create branch** — `git checkout -b <botname>/<short-description>` from latest `main`
3. **Write code** — make changes, commit with clear messages
4. **Push branch** — `git push origin <branch>`
5. **Create PR** — `gh pr create` with title, description, and labels
6. **Iterate** — respond to review comments, push fixes

## Branch Naming

```
<botname>/<short-description>
```

Examples: `cid/fix-thread-routing`, `parker/add-health-endpoint`

Always branch from latest `main`:
```bash
git fetch origin
git checkout -b cid/my-feature origin/main
```

## Creating PRs

```bash
gh pr create --title "Short title" --body "$(cat <<'EOF'
## Summary
<1-3 bullet points explaining what and why>

## Design reference
<which docs/design/ spec this implements or fixes, if applicable>

## Test plan
- [ ] Built successfully (`npm run build`)
- [ ] Tested locally
- [ ] README siblings updated (pre-commit enforces this)
EOF
)"
```

Add labels as appropriate:
- `--label bug` for defect fixes
- `--label enhancement` for new features
- `--label documentation` for doc-only changes

## Creating Issues

### Defect (replaces BUGS.md)

```bash
gh issue create --title "BUG: <short title>" --label defect --body "$(cat <<'EOF'
**Component:** <relay | main | container | etc.>
**Symptom:** What the user observes.
**Root cause:** Known or TBD.
**Steps to reproduce:** If known.
EOF
)"
```

### Enhancement (replaces NEXT.md)

```bash
gh issue create --title "<short title>" --label enhancement --body "$(cat <<'EOF'
**Goal:** What this achieves.
**Design reference:** docs/design/XX-name.md (if applicable)
**Scope:** What's in and out of scope.
EOF
)"
```

## Commit Messages

Follow conventional commits:
- `fix: <description>` — bug fixes
- `feat: <description>` — new features
- `refactor: <description>` — restructuring without behavior change
- `docs: <description>` — documentation only
- `chore: <description>` — maintenance, deps, config

## Design Review PRs

When updating code to match a design spec:
1. Read the design doc thoroughly
2. Identify gaps between spec and implementation
3. Create a branch and fix the gaps
4. Reference the design doc in the PR description
5. Note any spec items that can't be implemented yet (and why)

## Rules

- **One concern per PR** — don't mix unrelated changes
- **Always build before pushing** — `npm run build` must succeed
- **Update README siblings** — pre-commit hook enforces this
- **Never force-push** — creates clean history
- **Link design docs** — reference `docs/design/XX-name.md` in PR descriptions
