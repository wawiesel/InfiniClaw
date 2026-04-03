import { ASSISTANT_NAME } from 'nanoclaw/config.js';
import { describe, expect, it } from 'vitest';

import { buildResumeSystemMessage } from '../resume-message.js';

describe('buildResumeSystemMessage', () => {
  it('keeps mission context alongside recent restart history', () => {
    const content = buildResumeSystemMessage({
      taskBlock: '\n\nActive tasks:\n- [in_progress] Fix Codex adapter resume',
      missionContext: [
        '[Persistent mission context - carry this forward unless user changes priorities]',
        'Current objective: Restore Tali in quarters',
        'Last progress: Router health checks fixed',
      ].join('\n'),
      recentMessages: [
        { sender_name: 'Captain', content: 'Please make sure quarters memory survives restart.' },
        { sender_name: 'operator', content: 'Tali should resume the task after waking.' },
      ],
    });

    expect(content).toContain('Current objective: Restore Tali in quarters');
    expect(content).toContain('Last progress: Router health checks fixed');
    expect(content).toContain('Active tasks:\n- [in_progress] Fix Codex adapter resume');
    expect(content).toContain('Here are the last 2 messages before restart:');
    expect(content).toContain('[Captain]: Please make sure quarters memory survives restart.');
    expect(content).toContain('[operator]: Tali should resume the task after waking.');
  });

  it('sanitizes trigger mentions and never reintroduces the old public no-progress reply', () => {
    const content = buildResumeSystemMessage({
      recentMessages: [
        { sender_name: 'Captain', content: `{{mention ${ASSISTANT_NAME}}} continue the in-flight fix after restart.` },
      ],
      pendingBranchBrainResults: '\n- stale result summary',
    });

    expect(content).toContain('[callout] continue the in-flight fix after restart.');
    expect(content).not.toContain(`{{mention ${ASSISTANT_NAME}}}`);
    expect(content).toContain('Do not send a public status reply to this system message.');
    expect(content).toContain('otherwise wait silently for the next instruction.');
    expect(content).not.toContain('If nothing was in progress, say so briefly and wait.');
    expect(content).toContain('Pending Branch Brain results:\n- stale result summary');
  });
});
