import fs from 'fs';

/**
 * Purpose: read optional JSON state from disk without forcing callers to special-case missing files.
 * Requirement: beacon bootstrap must reuse existing fleet state when it is already present.
 */
export function readJsonFile<T>(file: string): T | null {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
}
