# scripts/

Operational shell scripts run on the host. Not imported by TypeScript — invoked directly or via npm scripts.

- `rebuild.sh` — Build script (`npm install` + `tsc`), called by `npm run build`
- `fleet-health.sh` — Fleet health reporting
- `health-check.sh` — Individual bot health diagnostics
- `health-history.sh` — Historical health data
- `metrics-report.sh` — Metrics collection
- `session-cleanup.sh` — Clean up old session files
- `setup-minio.sh` — MinIO/S3 initialization
- `hooks/` — Git hooks (pre-commit, pre-push)
