/**
 * Shared env file utilities.
 * Used by container-runner, index, ipc, and service.
 */
import fs from 'fs';

/** Parse a single KEY=value line from a .env file. Returns null for comments/blanks. */
export function parseEnvLine(line: string): [string, string] | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (!match) return null;
  const key = match[1];
  let value = match[2];
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return [key, value];
}

/** Read all key=value pairs from an env file. */
export function parseEnvFile(filePath: string): Record<string, string> {
  const values: Record<string, string> = {};
  if (!fs.existsSync(filePath)) return values;
  for (const line of fs.readFileSync(filePath, 'utf-8').split('\n')) {
    const parsed = parseEnvLine(line);
    if (parsed) values[parsed[0]] = parsed[1];
  }
  return values;
}

/** Insert or replace a key=value in an env file. */
export function upsertEnvLine(envFile: string, key: string, value: string): void {
  const lines = fs.existsSync(envFile)
    ? fs.readFileSync(envFile, 'utf-8').split('\n')
    : [];
  const next = `${key}=${value}`;
  let replaced = false;
  const updated = lines.map((line) => {
    if (line.startsWith(`${key}=`)) {
      replaced = true;
      return next;
    }
    return line;
  });
  if (!replaced) updated.push(next);
  fs.writeFileSync(envFile, `${updated.join('\n').replace(/\n*$/, '\n')}`);
}

/** Detect if a base URL points to an Ollama instance (by name or port 11434). */
export function isOllamaBaseUrl(baseUrl: string | undefined): boolean {
  const trimmed = baseUrl?.trim();
  if (!trimmed) return false;

  const normalized = trimmed.toLowerCase();
  if (normalized.includes('ollama')) return true;

  try {
    const parsed = new URL(trimmed);
    const port =
      parsed.port ||
      (parsed.protocol === 'https:' ? '443' : parsed.protocol === 'http:' ? '80' : '');
    return port === '11434';
  } catch {
    return false;
  }
}
