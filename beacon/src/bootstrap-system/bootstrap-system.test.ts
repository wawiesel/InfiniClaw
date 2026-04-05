import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { defaultBootstrapInput } from '../default-bootstrap-input/default-bootstrap-input.js';
import { bootstrapSystem } from './bootstrap-system.js';

const dirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beacon-bootstrap-system-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('bootstrapSystem', () => {
  it('returns a dry-run result without writing files', () => {
    const publicDir = tmpDir();
    const secretsDir = tmpDir();
    const stateDir = path.join(tmpDir(), 'state');
    const input = defaultBootstrapInput({
      fleetName: 'OGIC',
      systemId: 'poseidon',
      name: 'Poseidon',
      emoji: '🌊',
      hostname: 'mac139160',
      publicDir,
      secretsDir,
      stateDir,
      relayVersion: 'v2.0.0',
      relayRepo: '/tmp/infiniclaw-relay',
      apply: false,
    });
    const result = bootstrapSystem(input);
    expect(result.systemRecord).toEqual({
      name: 'Poseidon',
      emoji: '🌊',
      hostname: 'mac139160',
    });
    expect(fs.existsSync(result.systemsPath)).toBe(false);
    expect(fs.existsSync(result.beaconStatePath)).toBe(false);
  });

  it('writes state on apply', () => {
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
      relayVersion: 'v2.0.0',
      relayRepo: '/tmp/infiniclaw-relay',
      spaceId: '!poseidon:a-gis.org',
      apply: true,
    });
    const result = bootstrapSystem(input);
    expect(JSON.parse(fs.readFileSync(result.systemsPath, 'utf-8'))).toEqual({
      poseidon: {
        name: 'Poseidon',
        emoji: '🌊',
        hostname: 'mac139160',
        spaceId: '!poseidon:a-gis.org',
      },
    });
    expect(JSON.parse(fs.readFileSync(result.beaconStatePath, 'utf-8')).systemId);
  });
});
