/**
 * Tests for WBS 10.2: Multi-fleet !fleet command.
 * Covers fleet selector parsing, fleet display names, ship filtering by fleet,
 * and structural verification of relay.ts multi-fleet implementation.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fleetId, clearShipConfigCache } from '../ship-config.js';
import type { ShipEntry } from '../ship-config.js';

beforeEach(() => {
  clearShipConfigCache();
  delete process.env['INFINICLAW_FLEET'];
});

// ── Fleet selector parsing (logic extracted for unit testing) ────────────────

/** Mirror of parseFleetSelector in relay.ts — must stay in sync. */
function parseFleetSelector(arg: string, currentFleet: string): string {
  const normalized = arg.trim().toLowerCase();
  if (!normalized) return currentFleet;
  if (normalized === 'all') return 'all';
  const icMatch = normalized.match(/^ic(\d+)$/);
  if (icMatch) return `infiniclaw${icMatch[1].padStart(2, '0')}`;
  if (/^infiniclaw\d+$/.test(normalized)) return normalized;
  return currentFleet;
}

describe('parseFleetSelector', () => {
  it('empty arg returns current fleet', () => {
    expect(parseFleetSelector('', 'infiniclaw00')).toBe('infiniclaw00');
    expect(parseFleetSelector('', 'infiniclaw01')).toBe('infiniclaw01');
  });

  it('all returns "all"', () => {
    expect(parseFleetSelector('all', 'infiniclaw00')).toBe('all');
    expect(parseFleetSelector('ALL', 'infiniclaw00')).toBe('all');
  });

  it('ic00 → infiniclaw00', () => {
    expect(parseFleetSelector('ic00', 'infiniclaw01')).toBe('infiniclaw00');
  });

  it('ic01 → infiniclaw01', () => {
    expect(parseFleetSelector('ic01', 'infiniclaw00')).toBe('infiniclaw01');
  });

  it('ic02 → infiniclaw02', () => {
    expect(parseFleetSelector('ic02', 'infiniclaw00')).toBe('infiniclaw02');
  });

  it('infiniclaw00 passthrough', () => {
    expect(parseFleetSelector('infiniclaw00', 'infiniclaw01')).toBe('infiniclaw00');
  });

  it('infiniclaw01 passthrough', () => {
    expect(parseFleetSelector('infiniclaw01', 'infiniclaw00')).toBe('infiniclaw01');
  });

  it('unrecognized arg falls back to current fleet', () => {
    expect(parseFleetSelector('engineering', 'infiniclaw00')).toBe('infiniclaw00');
    expect(parseFleetSelector('bridge', 'infiniclaw01')).toBe('infiniclaw01');
  });

  it('is case-insensitive', () => {
    expect(parseFleetSelector('IC00', 'infiniclaw01')).toBe('infiniclaw00');
    expect(parseFleetSelector('IC01', 'infiniclaw00')).toBe('infiniclaw01');
    expect(parseFleetSelector('InfiniClaw00', 'infiniclaw01')).toBe('infiniclaw00');
  });
});

// ── Fleet display names ───────────────────────────────────────────────────────

const FLEET_DISPLAY: Record<string, { emoji: string; name: string }> = {
  infiniclaw00: { emoji: '🌌', name: 'InfiniClaw00' },
  infiniclaw01: { emoji: '🧪', name: 'InfiniClaw01' },
};

function fleetDisplayName(fleet: string): string {
  const d = FLEET_DISPLAY[fleet];
  return d ? `${d.emoji}${d.name}` : fleet;
}

describe('fleetDisplayName', () => {
  it('IC00 gets star emoji', () => {
    expect(fleetDisplayName('infiniclaw00')).toBe('🌌InfiniClaw00');
  });

  it('IC01 gets flask emoji', () => {
    expect(fleetDisplayName('infiniclaw01')).toBe('🧪InfiniClaw01');
  });

  it('unknown fleet returns fleet id as-is', () => {
    expect(fleetDisplayName('infiniclaw99')).toBe('infiniclaw99');
  });
});

// ── Ship fleet field filtering ────────────────────────────────────────────────

describe('ShipEntry fleet field', () => {
  it('ShipEntry type accepts optional fleet field', () => {
    const ship: ShipEntry = {
      hostname: 'test-host',
      ip: null,
      os: 'linux',
      user: null,
      commissioned: true,
      rank: 1,
      fleet: 'infiniclaw01',
    };
    expect(ship.fleet).toBe('infiniclaw01');
  });

  it('ShipEntry type works without fleet field (backward compat)', () => {
    const ship: ShipEntry = {
      hostname: 'test-host',
      ip: null,
      os: 'linux',
      user: null,
      commissioned: true,
      rank: 1,
    };
    expect(ship.fleet).toBeUndefined();
  });

  it('ships without fleet field default to infiniclaw00 in filtering', () => {
    const ships: Record<string, ShipEntry> = {
      Herc: { hostname: 'herc', ip: null, os: 'linux', user: null, commissioned: true, rank: 1 },
      Posi: { hostname: 'posi', ip: null, os: 'linux', user: null, commissioned: true, rank: 2, fleet: 'infiniclaw00' },
      Stg1: { hostname: 'stg1', ip: null, os: 'linux', user: null, commissioned: true, rank: 1, fleet: 'infiniclaw01' },
    };

    const ic00Ships = Object.fromEntries(
      Object.entries(ships).filter(([, s]) => (s.fleet ?? 'infiniclaw00') === 'infiniclaw00'),
    );
    expect(Object.keys(ic00Ships)).toEqual(['Herc', 'Posi']); // Herc defaulted to ic00

    const ic01Ships = Object.fromEntries(
      Object.entries(ships).filter(([, s]) => (s.fleet ?? 'infiniclaw00') === 'infiniclaw01'),
    );
    expect(Object.keys(ic01Ships)).toEqual(['Stg1']);
  });
});

// ── Structural: relay.ts contains multi-fleet implementation ─────────────────

describe('relay.ts multi-fleet implementation', () => {
  const relayPath = path.resolve(import.meta.dirname, '..', 'relay.ts');
  const source = fs.readFileSync(relayPath, 'utf-8');

  it('exports parseFleetSelector helper function', () => {
    expect(source).toMatch(/function parseFleetSelector\(/);
  });

  it('exports fleetDisplayName helper function', () => {
    expect(source).toMatch(/function fleetDisplayName\(/);
  });

  it('uses fleet-namespaced S3 prefix via fleetReportPrefix', () => {
    expect(source).toMatch(/function fleetReportPrefix\(/);
    expect(source).toMatch(/fleetReportPrefix\(fleetId\(\)\)/);
  });

  it('FLEET_ASSEMBLED_S3_KEY is fleet-namespaced', () => {
    expect(source).toMatch(/fleet-assembled\/\$\{fleetId\(\)\}\/latest\.json/);
  });

  it('fleet handler parses fleet selector from cmd', () => {
    expect(source).toMatch(/parseFleetSelector\(arg\)/);
  });

  it('fleet handler filters ships by fleet', () => {
    expect(source).toMatch(/visibleShips/);
  });

  it('fleet handler reads S3 keys per ship fleet', () => {
    expect(source).toMatch(/fleetReportPrefix\(shipFleet\)/);
  });

  it('fleet handler has dynamic header label', () => {
    expect(source).toMatch(/fleetDisplayName\(targetFleet\)/);
  });

  it('fleet handler supports !fleet all with section headers', () => {
    expect(source).toMatch(/targetFleet === 'all'/);
    expect(source).toMatch(/All Fleets/);
  });
});
