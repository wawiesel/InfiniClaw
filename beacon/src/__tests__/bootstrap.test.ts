import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { bootstrapSystem, defaultBootstrapInput } from '../bootstrap.js';

const tempDirs: string[] = [];

function mkTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('bootstrapSystem', () => {
  it('dry run returns normalized bootstrap result without writing files', () => {
    const publicDir = mkTempDir('beacon-public-');
    const secretsDir = mkTempDir('beacon-secrets-');
    const stateDir = path.join(mkTempDir('beacon-state-parent-'), 'state');

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
    expect(result.relayStartCommand).toEqual([
      'node',
      '/tmp/infiniclaw-relay/dist/cli.js',
      'relay',
      'start',
    ]);
    expect(fs.existsSync(result.systemsPath)).toBe(false);
    expect(fs.existsSync(result.beaconStatePath)).toBe(false);
  });

  it('apply writes systems.json and beacon-state.json', () => {
    const publicDir = mkTempDir('beacon-public-');
    const secretsDir = mkTempDir('beacon-secrets-');
    const stateDir = mkTempDir('beacon-state-');

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
    const systems = JSON.parse(fs.readFileSync(result.systemsPath, 'utf-8')) as Record<string, unknown>;
    const state = JSON.parse(fs.readFileSync(result.beaconStatePath, 'utf-8')) as Record<string, unknown>;

    expect(systems['poseidon']).toEqual({
      name: 'Poseidon',
      emoji: '🌊',
      hostname: 'mac139160',
      spaceId: '!poseidon:a-gis.org',
    });
    expect(state['systemId']).toBe('poseidon');
    expect(state['relayVersion']).toBe('v2.0.0');
  });

  it('preserves an existing spaceId when a new one is not supplied', () => {
    const publicDir = mkTempDir('beacon-public-');
    const secretsDir = mkTempDir('beacon-secrets-');
    const stateDir = mkTempDir('beacon-state-');
    fs.writeFileSync(
      path.join(publicDir, 'systems.json'),
      `${JSON.stringify({
        poseidon: {
          name: 'Poseidon',
          emoji: '🌊',
          hostname: 'old-host',
          spaceId: '!existing:a-gis.org',
        },
      }, null, 2)}\n`,
    );

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
      apply: true,
    });

    const result = bootstrapSystem(input);
    const systems = JSON.parse(fs.readFileSync(result.systemsPath, 'utf-8')) as Record<string, any>;

    expect(systems.poseidon.hostname).toBe('mac139160');
    expect(systems.poseidon.spaceId).toBe('!existing:a-gis.org');
  });
});
