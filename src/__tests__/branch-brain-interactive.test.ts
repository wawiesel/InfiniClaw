import { describe, it, expect } from 'vitest';
import { formatContextInjectionMessage } from '../relay.js';

// ── formatContextInjectionMessage ──────────────────────────────────

describe('formatContextInjectionMessage', () => {
  it('returns valid JSON stream-json user_message', () => {
    const result = formatContextInjectionMessage('Fix auth bug', 'Hey, the login endpoint is also broken.');
    const parsed = JSON.parse(result.trim());
    expect(parsed.type).toBe('user_message');
    expect(parsed.content).toContain('You are branch brain Fix auth bug.');
    expect(parsed.content).toContain('Hey, the login endpoint is also broken.');
  });

  it('includes the BB title in the message content', () => {
    const result = formatContextInjectionMessage('Deploy pipeline', 'Server is down');
    const parsed = JSON.parse(result.trim());
    expect(parsed.content).toContain('You are branch brain Deploy pipeline.');
  });

  it('includes the main timeline message in content', () => {
    const result = formatContextInjectionMessage('Fix bug', 'Urgent: rollback needed');
    const parsed = JSON.parse(result.trim());
    expect(parsed.content).toContain('Here is a message from main timeline: Urgent: rollback needed.');
  });

  it('always ends with a trailing newline', () => {
    const result = formatContextInjectionMessage('title', 'msg');
    expect(result.endsWith('\n')).toBe(true);
  });

  it('includes the non-applicable note', () => {
    const result = formatContextInjectionMessage('t', 'm');
    const parsed = JSON.parse(result.trim());
    expect(parsed.content).toContain('It may not apply to you. If it does, modify your task accordingly.');
  });
});
