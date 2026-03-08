/** Shared low-level utilities used across multiple InfiniClaw modules. */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Single-quote a value for safe embedding in a bash script. */
export function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

export function errStr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
