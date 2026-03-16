import { describe, it, expect } from 'vitest';
import { formatContextInjectionMessage } from '../relay.js';

// ── formatContextInjectionMessage ──────────────────────────────────

describe('formatContextInjectionMessage', () => {
  it('formats the context injection message correctly', () => {
    const result = formatContextInjectionMessage('Fix auth bug', 'Hey, the login endpoint is also broken.');
    expect(result).toBe(
      'You are branch brain Fix auth bug. Here is a message from main timeline: Hey, the login endpoint is also broken.. It may not apply to you. If it does, modify your task accordingly.\n',
    );
  });

  it('includes the BB title in the message', () => {
    const result = formatContextInjectionMessage('Deploy pipeline', 'Server is down');
    expect(result).toContain('You are branch brain Deploy pipeline.');
  });

  it('includes the main timeline message', () => {
    const result = formatContextInjectionMessage('Fix bug', 'Urgent: rollback needed');
    expect(result).toContain('Here is a message from main timeline: Urgent: rollback needed.');
  });

  it('always ends with a trailing newline', () => {
    const result = formatContextInjectionMessage('title', 'msg');
    expect(result.endsWith('\n')).toBe(true);
  });

  it('includes the non-applicable note', () => {
    const result = formatContextInjectionMessage('t', 'm');
    expect(result).toContain('It may not apply to you. If it does, modify your task accordingly.');
  });
});
