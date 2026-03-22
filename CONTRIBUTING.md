# Contributing

## Commit Style

[Conventional Commits](https://www.conventionalcommits.org/) — `<type>[scope]: <description>`.
Common types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`.
No `Co-Authored-By` trailers — no attribution clutter.

## PR Process

1. Branch from `main`: `git checkout -b <type>/<short-description>`
2. Push and open a PR: `gh pr create` or Gitea UI — target `main`, squash-merge preferred

## Tests

Pre-push hook enforces automatically:
1. `npx tsc --noEmit` — type-check nanoclaw + InfiniClaw
2. `npm test` — full test suite

Run manually before pushing: `npx tsc --noEmit && npm test`

Results are cached by commit hash (5-minute TTL) to skip redundant re-checks.
