import { describe, it, expect } from 'vitest';
import { formatContextInjectionMessage, buildReactivationObjective } from '../relay.js';

describe('formatContextInjectionMessage', () => {
  it('formats the injection message with spec wording', () => {
    const result = formatContextInjectionMessage('Fix auth bug', 'Please also check the token expiry logic.');
    expect(result).toBe(
      'You are branch brain Fix auth bug. Here is a message from main timeline: Please also check the token expiry logic.. It may not apply to you. If it does, modify your task accordingly.\n',
    );
  });

  it('includes the exact spec wording', () => {
    const result = formatContextInjectionMessage('Deploy pipeline', 'Deploy to staging now.');
    expect(result).toContain('You are branch brain Deploy pipeline.');
    expect(result).toContain('Here is a message from main timeline: Deploy to staging now.');
    expect(result).toContain('It may not apply to you. If it does, modify your task accordingly.');
  });

  it('always ends with a trailing newline', () => {
    const result = formatContextInjectionMessage('title', 'msg');
    expect(result.endsWith('\n')).toBe(true);
  });

  it('handles empty message gracefully', () => {
    const result = formatContextInjectionMessage('Some task', '');
    expect(result).toContain('You are branch brain Some task.');
    expect(typeof result).toBe('string');
  });

  it('handles title with special characters', () => {
    const result = formatContextInjectionMessage('Fix: auth & token < > issue', 'context msg');
    expect(result).toContain('You are branch brain Fix: auth & token < > issue.');
  });
});

describe('buildReactivationObjective', () => {
  it('includes original objective', () => {
    const result = buildReactivationObjective('Investigate the auth bug', 'Did you find the root cause?', 'Investigate the auth bug');
    expect(result).toContain('Original objective: Investigate the auth bug');
  });

  it('includes the follow-up message', () => {
    const result = buildReactivationObjective('Fix DB schema', 'Also update the migration file.', 'Fix DB schema');
    expect(result).toContain('Also update the migration file.');
  });

  it('includes the thread title in follow-up header', () => {
    const result = buildReactivationObjective('Original task', 'New question', 'My Thread Title');
    expect(result).toContain('Follow-up from Captain in thread "My Thread Title":');
  });

  it('returns a multi-line string with all parts', () => {
    const result = buildReactivationObjective('obj', 'followup', 'title');
    const lines = result.split('\n');
    expect(lines.some(l => l.startsWith('Original objective:'))).toBe(true);
    expect(lines.some(l => l.startsWith('Follow-up from Captain in thread'))).toBe(true);
    expect(lines[lines.length - 1]).toBe('followup');
  });

  it('handles multi-line original objectives', () => {
    const original = 'Step 1: do this\nStep 2: do that\nStep 3: profit';
    const result = buildReactivationObjective(original, 'Any updates?', 'Step 1: do this');
    expect(result).toContain(original);
    expect(result).toContain('Any updates?');
  });
});
