import { _initTestDatabase } from 'nanoclaw/db.js';
import { beforeEach, describe, expect, it } from 'vitest';

import { buildMainMissionContext, markProgress, setObjectiveFromMessages } from '../chat-activity.js';

describe('chat activity objective tracking', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('ignores relay, system, and bot messages when updating the current objective', () => {
    const chatJid = `matrix:objective-${Date.now()}`;

    setObjectiveFromMessages(chatJid, [
      {
        id: 'captain-1',
        chat_jid: chatJid,
        sender: '@captain:a-gis.org',
        sender_name: 'Captain',
        content: 'Resume the PR review and find the web URL.',
        timestamp: new Date().toISOString(),
      },
    ]);

    setObjectiveFromMessages(chatJid, [
      {
        id: 'relay-1',
        chat_jid: chatJid,
        sender: '@loudspeaker:a-gis.org',
        sender_name: 'relay',
        content: '[🪽📡 Hermes] 📡 sleep Tali',
        timestamp: new Date().toISOString(),
      },
      {
        id: 'system-1',
        chat_jid: chatJid,
        sender: 'system',
        sender_name: 'System',
        content: 'You were restarted.',
        timestamp: new Date().toISOString(),
      },
      {
        id: 'bot-1',
        chat_jid: chatJid,
        sender: 'Tali',
        sender_name: 'Tali',
        content: 'https://example.invalid/result',
        timestamp: new Date().toISOString(),
        is_bot_message: true,
      },
    ]);

    const missionContext = buildMainMissionContext(chatJid);
    expect(missionContext).toContain('Current objective: Resume the PR review and find the web URL.');
    expect(missionContext).not.toContain('sleep Tali');
    expect(missionContext).not.toContain('You were restarted.');
    expect(missionContext).not.toContain('https://example.invalid/result');
  });

  it('includes the latest progress in the mission context', () => {
    const chatJid = `matrix:progress-${Date.now()}`;

    setObjectiveFromMessages(chatJid, [
      {
        id: 'captain-2',
        chat_jid: chatJid,
        sender: '@captain:a-gis.org',
        sender_name: 'Captain',
        content: 'Continue the Codex adapter fix.',
        timestamp: new Date().toISOString(),
      },
    ]);
    markProgress(chatJid, 'Router health checks fixed and resume prompt patched');

    const missionContext = buildMainMissionContext(chatJid);
    expect(missionContext).toContain('Current objective: Continue the Codex adapter fix.');
    expect(missionContext).toContain('Last progress: Router health checks fixed and resume prompt patched');
  });
});
