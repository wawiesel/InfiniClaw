---
name: gitea-development
description: Gitea-based development workflow using branches, PRs, and issues. Use when assigned a task — creating branches, writing code, committing, pushing, and opening PRs via Gitea API.
---

# Gitea Development

## Setup

Gitea credentials are in your environment:
- `GITEA_URL` — Gitea instance URL
- `GITEA_USERNAME` — your Gitea username
- `GITEA_TOKEN` — your API token

## Workflow

1. **Receive assignment** — operator assigns you a task or issue
2. **Create branch** — `git checkout -b <botname>/<short-description>` from latest `main`
3. **Write code** — make changes, commit with clear messages
4. **Push branch** — `git push origin <branch>`
5. **Create PR** — via Gitea API (see below)
6. **Iterate** — respond to review comments, push fixes

## Branch Naming

```
<botname>/<short-description>
```

Examples: `tali/fix-thread-routing`, `parker/add-health-endpoint`

Always branch from latest `main`:
```bash
git fetch origin
git checkout -b tali/my-feature origin/main
```

## Creating PRs

```bash
curl -s -H "Authorization: token $GITEA_TOKEN" \
  -H "Content-Type: application/json" \
  -X POST "$GITEA_URL/api/v1/repos/wawiesel/infiniclaw/pulls" \
  -d "{
    \"title\": \"Short title\",
    \"head\": \"<branch-name>\",
    \"base\": \"main\",
    \"body\": \"## Summary\n<description>\n\n## Test plan\n- [ ] Built successfully\n- [ ] Tested locally\"
  }"
```

## Creating Issues

```bash
curl -s -H "Authorization: token $GITEA_TOKEN" \
  -H "Content-Type: application/json" \
  -X POST "$GITEA_URL/api/v1/repos/wawiesel/infiniclaw/issues" \
  -d "{
    \"title\": \"<short title>\",
    \"body\": \"**Component:** <area>\n**Description:** <details>\"
  }"
```

## Listing Issues

```bash
curl -s -H "Authorization: token $GITEA_TOKEN" \
  "$GITEA_URL/api/v1/repos/wawiesel/infiniclaw/issues?state=open&type=issues"
```

## Commit Messages

Follow conventional commits:
- `fix: <description>` — bug fixes
- `feat: <description>` — new features
- `refactor: <description>` — restructuring without behavior change
- `docs: <description>` — documentation only
- `chore: <description>` — maintenance, deps, config

## Rules

- **One concern per PR** — don't mix unrelated changes
- **Always build before pushing** — `npm run build` must succeed
- **Update README siblings** — pre-commit hook enforces this
- **Never force-push** — creates clean history
- **Link design docs** — reference `docs/design/XX-name.md` in PR descriptions
