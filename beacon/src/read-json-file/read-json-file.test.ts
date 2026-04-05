import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { readJsonFile } from './read-json-file.js';

const dirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beacon-read-json-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('readJsonFile', () => {
  it('returns null for a missing file', () => {
    expect(readJsonFile('/tmp/definitely-missing-beacon-file.json')).toBeNull();
  });

  it('reads and parses JSON content', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'data.json');
    fs.writeFileSync(file, '{"ok":true}\n');
    expect(readJsonFile<{ ok: boolean }>(file)).toEqual({ ok: true });
  });
});
