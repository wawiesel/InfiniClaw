import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { writeJsonFile } from './write-json-file.js';

const dirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beacon-write-json-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('writeJsonFile', () => {
  it('creates parent directories and writes formatted JSON', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'nested', 'state.json');
    writeJsonFile(file, { ok: true });
    expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toEqual({ ok: true });
  });
});
