import { describe, it, expect } from 'vitest';
import { mapBrainEnv } from '../relay.js';

// ── mapBrainEnv ────────────────────────────────────────────────────

describe('mapBrainEnv', () => {
  it('returns base env unchanged when botEnv is null', () => {
    const base = { SOME_VAR: 'value', CLAUDECODE: '1' };
    const result = mapBrainEnv(null, { ...base });
    expect(result['SOME_VAR']).toBe('value');
  });

  it('always deletes CLAUDECODE (even with null botEnv)', () => {
    const result = mapBrainEnv(null, { CLAUDECODE: '1' });
    expect(result['CLAUDECODE']).toBeUndefined();
  });

  it('maps BRAIN_OAUTH_TOKEN → CLAUDE_CODE_OAUTH_TOKEN', () => {
    const result = mapBrainEnv({ BRAIN_OAUTH_TOKEN: 'tok123' }, {});
    expect(result['CLAUDE_CODE_OAUTH_TOKEN']).toBe('tok123');
  });

  it('prefers CLAUDE_CODE_OAUTH_TOKEN over BRAIN_OAUTH_TOKEN', () => {
    const result = mapBrainEnv(
      { CLAUDE_CODE_OAUTH_TOKEN: 'direct', BRAIN_OAUTH_TOKEN: 'fallback' },
      {},
    );
    expect(result['CLAUDE_CODE_OAUTH_TOKEN']).toBe('direct');
  });

  it('maps BRAIN_API_KEY → ANTHROPIC_API_KEY', () => {
    const result = mapBrainEnv({ BRAIN_API_KEY: 'key-abc' }, {});
    expect(result['ANTHROPIC_API_KEY']).toBe('key-abc');
  });

  it('prefers ANTHROPIC_API_KEY over BRAIN_API_KEY', () => {
    const result = mapBrainEnv(
      { ANTHROPIC_API_KEY: 'direct', BRAIN_API_KEY: 'fallback' },
      {},
    );
    expect(result['ANTHROPIC_API_KEY']).toBe('direct');
  });

  it('maps BRAIN_MODEL → ANTHROPIC_MODEL', () => {
    const result = mapBrainEnv({ BRAIN_MODEL: 'claude-opus-4-6' }, {});
    expect(result['ANTHROPIC_MODEL']).toBe('claude-opus-4-6');
  });

  it('prefers ANTHROPIC_MODEL over BRAIN_MODEL', () => {
    const result = mapBrainEnv(
      { ANTHROPIC_MODEL: 'direct', BRAIN_MODEL: 'fallback' },
      {},
    );
    expect(result['ANTHROPIC_MODEL']).toBe('direct');
  });

  it('forwards ANTHROPIC_BASE_URL as-is', () => {
    const result = mapBrainEnv({ ANTHROPIC_BASE_URL: 'https://proxy.example.com' }, {});
    expect(result['ANTHROPIC_BASE_URL']).toBe('https://proxy.example.com');
  });

  it('forwards ANTHROPIC_AUTH_TOKEN as-is', () => {
    const result = mapBrainEnv({ ANTHROPIC_AUTH_TOKEN: 'bearer-token' }, {});
    expect(result['ANTHROPIC_AUTH_TOKEN']).toBe('bearer-token');
  });

  it('forwards NODE_EXTRA_CA_CERTS as-is', () => {
    const result = mapBrainEnv({ NODE_EXTRA_CA_CERTS: '/etc/ssl/certs/ca.pem' }, {});
    expect(result['NODE_EXTRA_CA_CERTS']).toBe('/etc/ssl/certs/ca.pem');
  });

  it('does not set missing optional fields', () => {
    const result = mapBrainEnv({}, {});
    expect(result['CLAUDE_CODE_OAUTH_TOKEN']).toBeUndefined();
    expect(result['ANTHROPIC_API_KEY']).toBeUndefined();
    expect(result['ANTHROPIC_MODEL']).toBeUndefined();
    expect(result['ANTHROPIC_BASE_URL']).toBeUndefined();
  });

  it('deletes CLAUDECODE even when botEnv has credentials', () => {
    const result = mapBrainEnv(
      { BRAIN_API_KEY: 'key' },
      { CLAUDECODE: '1', OTHER: 'val' },
    );
    expect(result['CLAUDECODE']).toBeUndefined();
    expect(result['OTHER']).toBe('val');
  });

  it('preserves unrelated base env vars', () => {
    const result = mapBrainEnv({ BRAIN_API_KEY: 'key' }, { PATH: '/usr/bin', HOME: '/root' });
    expect(result['PATH']).toBe('/usr/bin');
    expect(result['HOME']).toBe('/root');
  });
});
