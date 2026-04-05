import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { defaultBootstrapInput } from '../default-bootstrap-input/default-bootstrap-input.js';
import { validateInput } from './validate-input.js';

const dirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beacon-validate-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('validateInput', () => {
  it('accepts valid input', () => {
    const publicDir = tmpDir();
    const secretsDir = tmpDir();
    const input = defaultBootstrapInput({
      publicDir,
      secretsDir,
      stateDir: path.join(tmpDir(), 'state'),
      relayRepo: '/tmp/infiniclaw-relay',
    });
    expect(() => validateInput(input)).not.toThrow();
  });

  it('rejects a missing publicDir', () => {
    const secretsDir = tmpDir();
    const input = defaultBootstrapInput({
      publicDir: '/tmp/missing-public-dir-beacon',
      secretsDir,
      stateDir: path.join(tmpDir(), 'state'),
      relayRepo: '/tmp/infiniclaw-relay',
    });
    expect(() => validateInput(input)).toThrow(/publicDir/);
  });
});
