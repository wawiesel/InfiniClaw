import { describe, it, expect, beforeEach } from 'vitest';

import { _initTestDatabase, getAllChats, storeChatMetadata } from 'nanoclaw/db.js';
import { TRIGGER_PATTERN, ASSISTANT_NAME } from 'nanoclaw/config.js';
import { NewMessage } from 'nanoclaw/types.js';
import { getAvailableGroups, _setRegisteredGroups, _resolveReplyThread, _setBotMatrixUserIds } from '../main.js';

beforeEach(() => {
  _initTestDatabase();
  _setRegisteredGroups({});
  _setBotMatrixUserIds(new Set());
});

// --- JID ownership patterns ---

describe('JID ownership patterns', () => {
  // These test the patterns that will become ownsJid() on the Channel interface

  it('WhatsApp group JID: ends with @g.us', () => {
    const jid = '12345678@g.us';
    expect(jid.endsWith('@g.us')).toBe(true);
  });

  it('WhatsApp DM JID: ends with @s.whatsapp.net', () => {
    const jid = '12345678@s.whatsapp.net';
    expect(jid.endsWith('@s.whatsapp.net')).toBe(true);
  });
});

// --- getAvailableGroups ---

describe('getAvailableGroups', () => {
  it('returns only groups, excludes DMs', () => {
    storeChatMetadata('group1@g.us', '2024-01-01T00:00:01.000Z', 'Group 1', 'whatsapp', true);
    storeChatMetadata('user@s.whatsapp.net', '2024-01-01T00:00:02.000Z', 'User DM', 'whatsapp', false);
    storeChatMetadata('group2@g.us', '2024-01-01T00:00:03.000Z', 'Group 2', 'whatsapp', true);

    const groups = getAvailableGroups();
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.jid)).toContain('group1@g.us');
    expect(groups.map((g) => g.jid)).toContain('group2@g.us');
    expect(groups.map((g) => g.jid)).not.toContain('user@s.whatsapp.net');
  });

  it('excludes __group_sync__ sentinel', () => {
    storeChatMetadata('__group_sync__', '2024-01-01T00:00:00.000Z');
    storeChatMetadata('group@g.us', '2024-01-01T00:00:01.000Z', 'Group', 'whatsapp', true);

    const groups = getAvailableGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].jid).toBe('group@g.us');
  });

  it('marks registered groups correctly', () => {
    storeChatMetadata('reg@g.us', '2024-01-01T00:00:01.000Z', 'Registered', 'whatsapp', true);
    storeChatMetadata('unreg@g.us', '2024-01-01T00:00:02.000Z', 'Unregistered', 'whatsapp', true);

    _setRegisteredGroups({
      'reg@g.us': {
        name: 'Registered',
        folder: 'registered',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    });

    const groups = getAvailableGroups();
    const reg = groups.find((g) => g.jid === 'reg@g.us');
    const unreg = groups.find((g) => g.jid === 'unreg@g.us');

    expect(reg?.isRegistered).toBe(true);
    expect(unreg?.isRegistered).toBe(false);
  });

  it('returns groups ordered by most recent activity', () => {
    storeChatMetadata('old@g.us', '2024-01-01T00:00:01.000Z', 'Old', 'whatsapp', true);
    storeChatMetadata('new@g.us', '2024-01-01T00:00:05.000Z', 'New', 'whatsapp', true);
    storeChatMetadata('mid@g.us', '2024-01-01T00:00:03.000Z', 'Mid', 'whatsapp', true);

    const groups = getAvailableGroups();
    expect(groups[0].jid).toBe('new@g.us');
    expect(groups[1].jid).toBe('mid@g.us');
    expect(groups[2].jid).toBe('old@g.us');
  });

  it('excludes non-group chats regardless of JID format', () => {
    // Unknown JID format stored without is_group should not appear
    storeChatMetadata('unknown-format-123', '2024-01-01T00:00:01.000Z', 'Unknown');
    // Explicitly non-group with unusual JID
    storeChatMetadata('custom:abc', '2024-01-01T00:00:02.000Z', 'Custom DM', 'custom', false);
    // A real group for contrast
    storeChatMetadata('group@g.us', '2024-01-01T00:00:03.000Z', 'Group', 'whatsapp', true);

    const groups = getAvailableGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].jid).toBe('group@g.us');
  });

  it('returns empty array when no chats exist', () => {
    const groups = getAvailableGroups();
    expect(groups).toHaveLength(0);
  });
});

// --- resolveReplyThread (BUG-21: isRoutableHuman) ---

function makeMsg(overrides: Partial<NewMessage> & { content: string; sender: string }): NewMessage {
  return {
    id: 'msg-' + Math.random().toString(36).slice(2),
    chat_jid: 'room:test',
    sender_name: 'Test',
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

const TRIGGER = `@${ASSISTANT_NAME}`;

describe('resolveReplyThread — BUG-21 isRoutableHuman', () => {
  it('routes to thread when human triggers bot in thread', () => {
    const msgs = [
      makeMsg({ sender: '@human:server', content: TRIGGER, thread_id: 'thread-1' }),
    ];
    expect(_resolveReplyThread('room:test', msgs)).toBe('thread-1');
  });

  it('does NOT route to thread when intercom sender triggers bot in thread', () => {
    // BUG-21: relay notifications like "⛔ !refresh Cid — fetch failed" must not
    // cause thread routing even though they match TRIGGER_PATTERN.
    const msgs = [
      makeMsg({ sender: '@cid-intercom:a-gis.org', content: TRIGGER, thread_id: 'thread-1' }),
    ];
    expect(_resolveReplyThread('room:test', msgs)).toBeUndefined();
  });

  it('does NOT route to thread when known bot sender triggers bot in thread', () => {
    _setBotMatrixUserIds(new Set(['@bot:server']));
    const msgs = [
      makeMsg({ sender: '@bot:server', content: TRIGGER, thread_id: 'thread-1' }),
    ];
    expect(_resolveReplyThread('room:test', msgs)).toBeUndefined();
  });

  it('routes to thread for human last message (CO fallback, no explicit trigger)', () => {
    // CO mode: last human message in thread → reply in that thread
    const msgs = [
      makeMsg({ sender: '@human:server', content: 'hey everyone', thread_id: 'thread-2' }),
    ];
    expect(_resolveReplyThread('room:test', msgs)).toBe('thread-2');
  });

  it('does NOT route to thread for intercom last message (CO fallback)', () => {
    // BUG-21: intercom last message must not trigger CO thread routing
    const msgs = [
      makeMsg({ sender: '@cid-intercom:a-gis.org', content: '⛔ !refresh Cid — fetch failed', thread_id: 'thread-2' }),
    ];
    expect(_resolveReplyThread('room:test', msgs)).toBeUndefined();
  });

  it('returns undefined when no messages have thread_id', () => {
    const msgs = [
      makeMsg({ sender: '@human:server', content: TRIGGER }),
    ];
    expect(_resolveReplyThread('room:test', msgs)).toBeUndefined();
  });

  it('prefers the most recent human trigger in thread over earlier ones', () => {
    const msgs = [
      makeMsg({ sender: '@human:server', content: TRIGGER, thread_id: 'thread-old' }),
      makeMsg({ sender: '@human:server', content: TRIGGER, thread_id: 'thread-new' }),
    ];
    expect(_resolveReplyThread('room:test', msgs)).toBe('thread-new');
  });

  it('skips intercom trigger and falls back to earlier human trigger', () => {
    const msgs = [
      makeMsg({ sender: '@human:server', content: TRIGGER, thread_id: 'thread-human' }),
      makeMsg({ sender: '@cid-intercom:a-gis.org', content: TRIGGER, thread_id: 'thread-intercom' }),
    ];
    // Intercom is last — should be ignored; human trigger earlier should win
    expect(_resolveReplyThread('room:test', msgs)).toBe('thread-human');
  });
});
