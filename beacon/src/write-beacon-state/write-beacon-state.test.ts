import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { defaultBootstrapInput } from '../default-bootstrap-input/default-bootstrap-input.js';
import { writeBeaconState } from './write-beacon-state.js';

const dirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beacon-state-write-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('writeBeaconState', () => {
  it('writes local beacon state when apply is true', () => {
    const publicDir = tmpDir();
    const secretsDir = tmpDir();
    const stateDir = tmpDir();
    const input = defaultBootstrapInput({
      publicDir,
      secretsDir,
      stateDir,
      relayRepo: '/tmp/infiniclaw-relay',
      apply: true,
    });
    const file = writeBeaconState(input, true);
    const state = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, string>;
    expect(state.systemId).toBe(input.systemId);
    expect(state.relayRepo).toBe('/tmp/infiniclaw-relay');
  });
});
