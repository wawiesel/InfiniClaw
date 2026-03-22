/**
 * Tests for WBS 13: S3 as single source of truth for fleet config.
 * Covers S3 key derivation, ships cache, and fleet config helpers.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  fleetConfigKey,
  SHIPS_S3_KEY,
  clearShipConfigCache,
  isValidBotName,
  SAFE_BOT_NAME,
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
