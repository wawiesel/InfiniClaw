import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { defaultBootstrapInput } from '../default-bootstrap-input/default-bootstrap-input.js';
import { upsertSystemRecord } from './upsert-system-record.js';

const dirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beacon-upsert-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('upsertSystemRecord', () => {
  it('writes systems.json when apply is true', () => {
    const publicDir = tmpDir();
    const secretsDir = tmpDir();
    const stateDir = tmpDir();
    const input = defaultBootstrapInput({
      systemId: 'poseidon',
      name: 'Poseidon',
      emoji: '🌊',
      hostname: 'mac139160',
      publicDir,
      secretsDir,
      stateDir,
      relayRepo: '/tmp/infiniclaw-relay',
      apply: true,
    });
    const result = upsertSystemRecord(input, true);
    expect(JSON.parse(fs.readFileSync(result.systemsPath, 'utf-8'))).toEqual({
      poseidon: {
        name: 'Poseidon',
        emoji: '🌊',
        hostname: 'mac139160',
      },
    });
  });
});
