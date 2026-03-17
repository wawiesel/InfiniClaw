/**
 * Pure helpers for cross-ship health-report staleness detection.
 * Kept separate so they can be unit-tested without importing relay.ts.
 */

export const STALE_HEALTH_THRESHOLD_MS = 30 * 60_000; // 30 min

/**
 * Parse the `ts` field from a raw health-report data object.
 * The relay writes `ts` as an ISO-8601 string; some callers may use epoch ms.
 * Returns NaN when the field is absent or unparseable.
 */
export function parseHealthReportTs(data: Record<string, unknown>): number {
  const ts = data.ts;
  if (typeof ts === 'number') return ts;
  if (typeof ts === 'string') return new Date(ts).getTime();
  return NaN;
}

/**
 * Return true when the report is older than `thresholdMs` relative to `now`.
 * Returns false (not stale) when the timestamp cannot be parsed, so we never
 * false-alarm on corrupt or missing data.
 */
export function isHealthReportStale(
  data: Record<string, unknown>,
  thresholdMs = STALE_HEALTH_THRESHOLD_MS,
  now = Date.now(),
): boolean {
  const ts = parseHealthReportTs(data);
  if (isNaN(ts)) return false;
  return now - ts > thresholdMs;
}
