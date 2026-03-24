# scripts/

- `hooks/` — Git hooks (pre-commit, pre-push), installed automatically on build
- `ic01-test.sh` — Quick bash smoke test: sends `!fleet` to IC01, asserts fleet response
- `ic01-harness.ts` — IC01 E2E test harness (WBS 17): `npx tsx scripts/ic01-harness.ts`
  - Login/logout lifecycle, `send`/`waitFor`/`assert` helpers, per-test pass/fail output
  - Add new `test()` blocks for WBS 17.2–17.8
