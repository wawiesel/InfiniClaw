/**
 * Tests for relay token flush logic — validates JSONL parsing produces
 * correct UsageRow fields for the dashboard ingest endpoint.
 */
import { describe, it, expect } from 'vitest';

// Simulate the relay's JSONL line → entry extraction (same logic as relay.ts)
function extractEntry(d: Record<string, unknown>, currentModel: string, sessionStart: string) {
  const u = (d as any).message?.usage;
  if (!u) return null;
  return {
    ts: d.timestamp as string,
    model: (d as any).message?.model || currentModel,
    input: u.input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    cw: u.cache_creation_input_tokens ?? 0,
    cr: u.cache_read_input_tokens ?? 0,
    session_id: (d.sessionId as string) || '',
    turn_id: (d.uuid as string) || '',
    sessionStart,
  };
}

// Simulate t_start computation
function computeTStart(entries: { ts: string; session_id: string; sessionStart: string }[], i: number): string {
  const e = entries[i];
  const prev = i > 0 && entries[i - 1].session_id === e.session_id ? entries[i - 1].ts : null;
  return prev || e.sessionStart || e.ts;
}

describe('JSONL line extraction', () => {
  const REAL_USAGE_LINE = {
    parentUuid: '73bb08ef',
    message: {
      model: 'claude-sonnet-4-6',
      usage: {
        input_tokens: 3,
        cache_creation_input_tokens: 2945,
        cache_read_input_tokens: 14093,
        output_tokens: 8,
      },
    },
    uuid: 'ebac471c-104e-4722-ae96-dfc5b6ff964a',
    timestamp: '2026-03-20T02:07:03.967Z',
    sessionId: 'd1a24f7d-ead0-417e-bd9a-e22001f75ce1',
  };

  it('extracts all fields from real JSONL usage line', () => {
    const e = extractEntry(REAL_USAGE_LINE, 'fallback-model', '2026-03-20T02:06:59.175Z');
    expect(e).not.toBeNull();
    expect(e!.model).toBe('claude-sonnet-4-6'); // from message, not fallback
    expect(e!.input).toBe(3);
    expect(e!.output).toBe(8);
    expect(e!.cw).toBe(2945);
    expect(e!.cr).toBe(14093);
    expect(e!.session_id).toBe('d1a24f7d-ead0-417e-bd9a-e22001f75ce1');
    expect(e!.turn_id).toBe('ebac471c-104e-4722-ae96-dfc5b6ff964a');
  });

  it('uses message.model over env fallback', () => {
    const e = extractEntry(REAL_USAGE_LINE, 'claude-opus-4-6', '');
    expect(e!.model).toBe('claude-sonnet-4-6');
  });

  it('falls back to env model when message.model missing', () => {
    const line = { ...REAL_USAGE_LINE, message: { usage: REAL_USAGE_LINE.message.usage } };
    const e = extractEntry(line, 'claude-opus-4-6', '');
    expect(e!.model).toBe('claude-opus-4-6');
  });

  it('skips lines without usage', () => {
    const noUsage = { timestamp: '2026-03-20T02:06:59Z', type: 'queue-operation' };
    expect(extractEntry(noUsage, 'model', '')).toBeNull();
  });

  it('handles missing uuid gracefully', () => {
    const noUuid = { ...REAL_USAGE_LINE };
    delete (noUuid as any).uuid;
    const e = extractEntry(noUuid, 'model', '');
    expect(e!.turn_id).toBe('');
  });

  it('handles missing cache fields (defaults to 0)', () => {
    const minUsage = {
      timestamp: '2026-03-20T02:07:03Z',
      sessionId: 'abc',
      uuid: 'xyz',
      message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 10, output_tokens: 20 } },
    };
    const e = extractEntry(minUsage, 'model', '');
    expect(e!.cw).toBe(0);
    expect(e!.cr).toBe(0);
  });
});

describe('t_start computation', () => {
  it('first turn in session uses sessionStart', () => {
    const entries = [
      { ts: '2026-03-20T02:07:03Z', session_id: 'sess1', sessionStart: '2026-03-20T02:06:59Z' },
    ];
    expect(computeTStart(entries, 0)).toBe('2026-03-20T02:06:59Z');
  });

  it('subsequent turn in same session uses previous t_end', () => {
    const entries = [
      { ts: '2026-03-20T02:07:03Z', session_id: 'sess1', sessionStart: '2026-03-20T02:06:59Z' },
      { ts: '2026-03-20T02:08:00Z', session_id: 'sess1', sessionStart: '2026-03-20T02:06:59Z' },
    ];
    expect(computeTStart(entries, 1)).toBe('2026-03-20T02:07:03Z');
  });

  it('first turn of NEW session uses its own sessionStart, not previous session t_end', () => {
    const entries = [
      { ts: '2026-03-20T02:07:03Z', session_id: 'sess1', sessionStart: '2026-03-20T02:06:59Z' },
      { ts: '2026-03-20T03:00:00Z', session_id: 'sess2', sessionStart: '2026-03-20T02:59:00Z' },
    ];
    // sess2's first turn should use sess2's sessionStart, NOT sess1's last timestamp
    expect(computeTStart(entries, 1)).toBe('2026-03-20T02:59:00Z');
  });

  it('falls back to t_end if no sessionStart', () => {
    const entries = [
      { ts: '2026-03-20T02:07:03Z', session_id: 'sess1', sessionStart: '' },
    ];
    expect(computeTStart(entries, 0)).toBe('2026-03-20T02:07:03Z');
  });
});
