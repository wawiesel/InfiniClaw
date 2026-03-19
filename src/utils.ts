/** Shared low-level utilities used across multiple InfiniClaw modules. */
import fs from 'fs';

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

/** Parse an integer env var, returning `defaultVal` if absent or non-numeric. */
export function envInt(name: string, defaultVal: number): number {
  const n = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) ? n : defaultVal;
}

/** Alias for envInt — parse a millisecond duration env var. */
export function envMs(name: string, defaultVal: number): number {
  return envInt(name, defaultVal);
}

/** Escape a string for use in a RegExp pattern. */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function errStr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Read and parse a JSON file.
 * Returns `fallback` on any error; throws if no fallback given.
 */
export function readJson<T>(filePath: string, fallback?: T): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch (err) {
    if (fallback !== undefined) return fallback;
    throw err;
  }
}

/**
 * Write `data` as pretty-printed JSON to `filePath` atomically (via .tmp rename).
 * Always appends a trailing newline.
 */
export function writeJson(filePath: string, data: unknown): void {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, filePath);
}
