import fs from 'fs';
import path from 'path';

/**
 * Purpose: write formatted JSON while creating any missing parent directories.
 * Requirement: beacon state writers must be able to materialize new local files safely.
 */
export function writeJsonFile(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
