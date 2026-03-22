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

  it('returns valid stream-json user_message with spec wording', () => {
    const result = formatContextInjectionMessage('Fix auth bug', 'Please also check the token expiry logic.');
    const parsed = JSON.parse(result.trim());
    expect(parsed.type).toBe('user_message');
    expect(parsed.content).toBe(
      'You are branch brain Fix auth bug. Here is a message from main timeline: Please also check the token expiry logic.. It may not apply to you. If it does, modify your task accordingly.',
    );
  });

  it('handles empty message gracefully', () => {
    const result = formatContextInjectionMessage('Some task', '');
    const parsed = JSON.parse(result.trim());
    expect(parsed.content).toContain('You are branch brain Some task.');
    expect(parsed.type).toBe('user_message');
  });

  it('handles title with special characters', () => {
    const result = formatContextInjectionMessage('Fix: auth & token < > issue', 'context msg');
    const parsed = JSON.parse(result.trim());
    expect(parsed.content).toContain('You are branch brain Fix: auth & token < > issue.');
  });
});
