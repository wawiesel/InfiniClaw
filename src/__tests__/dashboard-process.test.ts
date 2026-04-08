import { describe, expect, it } from 'vitest';

import { decideDashboardProcessAction } from '../service.js';

describe('decideDashboardProcessAction', () => {
  it('starts the dashboard on the designated host when missing', () => {
    expect(decideDashboardProcessAction(true, false, 'startup')).toBe('started');
  });

  it('leaves an already-running dashboard alone during startup', () => {
    expect(decideDashboardProcessAction(true, true, 'startup')).toBe('already-running');
  });

  it('restarts an existing dashboard after dashboard code changes', () => {
    expect(decideDashboardProcessAction(true, true, 'code-change')).toBe('restarted');
  });

  it('starts the dashboard after code changes when it is missing on the host', () => {
    expect(decideDashboardProcessAction(true, false, 'code-change')).toBe('started');
  });

  it('stops a stray dashboard on non-host systems', () => {
    expect(decideDashboardProcessAction(false, true, 'startup')).toBe('stopped');
  });

  it('does nothing on non-host systems when no dashboard is running', () => {
    expect(decideDashboardProcessAction(false, false, 'startup')).toBe('disabled');
  });
});
