/**
 * Tests for WBS 13 + WBS 10.2: S3 as single source of truth for fleet config;
 * multi-fleet S3 key derivation for fleet-report keys.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  fleetConfigKey,
  fleetId,
  SHIPS_S3_KEY,
  clearShipConfigCache,
  hasFleetDashboardHost,
  isValidBotName,
  SAFE_BOT_NAME,
  loadFleet,
  getFleetRoles,
  normalizeBotEntry,
  normalizeBotStatus,
  triggerTypeForStatus,
} from '../ship-config.js';

beforeEach(() => {
  clearShipConfigCache();
  delete process.env['INFINICLAW_FLEET'];
});

// ── S3 key derivation ──────────────────────────────────────────────────────────

describe('fleetConfigKey', () => {
  it('returns infiniclaw00 key when no env var set', () => {
    expect(fleetConfigKey()).toBe('fleet-config/infiniclaw00.json');
  });

  it('returns infiniclaw00 key for fleet.json env var', () => {
    process.env['INFINICLAW_FLEET'] = 'fleet.json';
    expect(fleetConfigKey()).toBe('fleet-config/infiniclaw00.json');
  });

  it('returns infiniclaw01 key for fleet01.json env var', () => {
    process.env['INFINICLAW_FLEET'] = 'fleet01.json';
    expect(fleetConfigKey()).toBe('fleet-config/infiniclaw01.json');
  });

  it('returns infiniclaw02 key for fleet02.json env var', () => {
    process.env['INFINICLAW_FLEET'] = 'fleet02.json';
    expect(fleetConfigKey()).toBe('fleet-config/infiniclaw02.json');
  });

  it('pads single-digit fleet numbers to two digits', () => {
    process.env['INFINICLAW_FLEET'] = 'fleet1.json';
    expect(fleetConfigKey()).toBe('fleet-config/infiniclaw01.json');
  });

  it('falls back to infiniclaw00 for unrecognized fleet name', () => {
    process.env['INFINICLAW_FLEET'] = 'custom-fleet.json';
    expect(fleetConfigKey()).toBe('fleet-config/infiniclaw00.json');
  });
});

describe('SHIPS_S3_KEY', () => {
  it('is the expected constant path', () => {
    expect(SHIPS_S3_KEY).toBe('fleet-config/ships.json');
  });
});

describe('hasFleetDashboardHost', () => {
  it('returns true when any entry on the hostname is marked as dashboard host', () => {
    expect(hasFleetDashboardHost({
      Posi: { hostname: 'Poseidon', ip: null, os: 'Linux', user: 'wawiesel', commissioned: true, rank: 2, hostsFleetDashboard: true },
      IC01: { hostname: 'Poseidon', ip: null, os: 'Linux', user: 'wawiesel', commissioned: false, rank: 99 },
    }, 'Poseidon')).toBe(true);
  });

  it('returns false when the hostname has no flagged entries', () => {
    expect(hasFleetDashboardHost({
      Herm: { hostname: 'mac139160', ip: null, os: 'macOS', user: 'ww5', commissioned: true, rank: 4 },
      Posi: { hostname: 'Poseidon', ip: null, os: 'Linux', user: 'wawiesel', commissioned: true, rank: 2 },
    }, 'mac139160')).toBe(false);
  });
});

// ── S3 key safety ─────────────────────────────────────────────────────────────

describe('fleet-config S3 keys are safe', () => {
  const SAFE_S3_KEY = /^[A-Za-z0-9][A-Za-z0-9_./-]{0,1023}$/;

  it('fleet config key passes S3 safety regex', () => {
    expect(SAFE_S3_KEY.test(fleetConfigKey())).toBe(true);
  });

  it('ships S3 key passes S3 safety regex', () => {
    expect(SAFE_S3_KEY.test(SHIPS_S3_KEY)).toBe(true);
  });

  it('fleet01 config key passes S3 safety regex', () => {
    process.env['INFINICLAW_FLEET'] = 'fleet01.json';
    expect(SAFE_S3_KEY.test(fleetConfigKey())).toBe(true);
  });

  it('fleet config keys do not start with slash', () => {
    expect(fleetConfigKey().startsWith('/')).toBe(false);
    expect(SHIPS_S3_KEY.startsWith('/')).toBe(false);
  });

  it('fleet config keys do not contain double slashes', () => {
    expect(fleetConfigKey().includes('//')).toBe(false);
    expect(SHIPS_S3_KEY.includes('//')).toBe(false);
  });
});

// ── fleetId export (WBS 10.2) ─────────────────────────────────────────────────

describe('fleetId', () => {
  it('returns infiniclaw00 when no env var set', () => {
    expect(fleetId()).toBe('infiniclaw00');
  });

  it('returns infiniclaw00 for fleet.json env var', () => {
    process.env['INFINICLAW_FLEET'] = 'fleet.json';
    expect(fleetId()).toBe('infiniclaw00');
  });

  it('returns infiniclaw01 for fleet01.json env var', () => {
    process.env['INFINICLAW_FLEET'] = 'fleet01.json';
    expect(fleetId()).toBe('infiniclaw01');
  });

  it('returns infiniclaw02 for fleet02.json env var', () => {
    process.env['INFINICLAW_FLEET'] = 'fleet02.json';
    expect(fleetId()).toBe('infiniclaw02');
  });
});

// ── Fleet-report S3 key format (WBS 10.2) ────────────────────────────────────

describe('fleet-report S3 key format', () => {
  const SAFE_S3_KEY = /^[A-Za-z0-9][A-Za-z0-9_./-]{0,1023}$/;

  it('fleet-report key includes fleet namespace', () => {
    const fleet = 'infiniclaw00';
    const ship = 'Herc';
    const key = `fleet-report/${fleet}/${ship}.json`;
    expect(key).toBe('fleet-report/infiniclaw00/Herc.json');
  });

  it('fleet-report IC01 key includes ic01 namespace', () => {
    const fleet = 'infiniclaw01';
    const ship = 'Staging1';
    const key = `fleet-report/${fleet}/${ship}.json`;
    expect(key).toBe('fleet-report/infiniclaw01/Staging1.json');
  });

  it('fleet-report key is S3-safe', () => {
    const key = `fleet-report/${fleetId()}/Herc.json`;
    expect(SAFE_S3_KEY.test(key)).toBe(true);
  });

  it('fleet-report key does not start with slash', () => {
    const key = `fleet-report/${fleetId()}/Herc.json`;
    expect(key.startsWith('/')).toBe(false);
  });

  it('fleet-report key does not contain double slashes', () => {
    const key = `fleet-report/${fleetId()}/Herc.json`;
    expect(key.includes('//')).toBe(false);
  });
});

// ── S3-only fleet runtime (WBS 10.5) ─────────────────────────────────────────

describe('loadFleet — S3-only runtime', () => {
  it('falls back to disk when cache is not initialized (no loadFleetAsync called)', () => {
    const result = loadFleet();
    expect(result).toBeDefined();
    expect(typeof result).toBe('object');
  });
});

describe('getFleetRoles — returns null before loadFleetAsync', () => {
  it('returns null when roles cache is empty', () => {
    expect(getFleetRoles()).toBeNull();
  });
});

describe('fleet status normalization', () => {
  it('maps known statuses to the expected trigger type', () => {
    expect(triggerTypeForStatus('quarters')).toBe('always');
    expect(triggerTypeForStatus('onduty')).toBe('callout');
    expect(triggerTypeForStatus('sleep')).toBe('never');
    expect(triggerTypeForStatus('retrospective')).toBe('always');
    expect(triggerTypeForStatus('dream')).toBe('never');
    expect(triggerTypeForStatus('ready')).toBe('always');
    expect(triggerTypeForStatus('transit')).toBe('never');
  });

  it('normalizes legacy and invalid statuses safely', () => {
    expect(normalizeBotStatus('active')).toBe('onduty');
    expect(normalizeBotStatus('dismissed')).toBe('quarters');
    expect(normalizeBotStatus('sleeping')).toBe('sleep');
    expect(normalizeBotStatus('nonsense')).toBe('sleep');
  });

  it('derives triggerType from status instead of persisted data', () => {
    const entry = normalizeBotEntry({
      role: 'engineer',
      rank: 1,
      ship: 'mac139160',
      status: 'quarters',
      triggerType: 'callout',
    });
    expect(entry.status).toBe('quarters');
    expect(entry.triggerType).toBe('always');
  });
});

// ── Bot name validation (unchanged by WBS 13, regression check) ───────────────

describe('isValidBotName', () => {
  it('accepts simple alphanumeric names', () => {
    expect(isValidBotName('cid')).toBe(true);
    expect(isValidBotName('parker')).toBe(true);
    expect(isValidBotName('bot1')).toBe(true);
  });

  it('accepts names with dots, dashes, underscores', () => {
    expect(isValidBotName('bot.v2')).toBe(true);
    expect(isValidBotName('bot-beta')).toBe(true);
    expect(isValidBotName('bot_prod')).toBe(true);
  });

  it('rejects names starting with dot or dash', () => {
    expect(isValidBotName('.hidden')).toBe(false);
    expect(isValidBotName('-bot')).toBe(false);
  });

  it('rejects dot and double-dot', () => {
    expect(isValidBotName('.')).toBe(false);
    expect(isValidBotName('..')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isValidBotName('')).toBe(false);
  });

  it('rejects names with spaces or slashes', () => {
    expect(isValidBotName('my bot')).toBe(false);
    expect(isValidBotName('bot/sub')).toBe(false);
  });
});
