import { describe, expect, it } from 'vitest';

import { isResumePoisonedApiError, shouldRetryWithoutResume } from '../resume-recovery.js';

describe('resume recovery', () => {
  it('treats invalid_request_error bad request as a poisoned resumed session', () => {
    expect(
      isResumePoisonedApiError(
        'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"Bad Request"}}',
      ),
    ).toBe(true);
  });

  it('retries when a resumed session exits nonzero with a poisoned API error result', () => {
    expect(
      shouldRetryWithoutResume({
        hadSession: true,
        exitCode: 1,
        interrupted: false,
        closedDuringRun: false,
        result: 'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"Bad Request"}}',
      }),
    ).toBe(true);
  });

  it('does not retry when there was no resumed session', () => {
    expect(
      shouldRetryWithoutResume({
        hadSession: false,
        exitCode: 1,
        interrupted: false,
        closedDuringRun: false,
        result: 'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"Bad Request"}}',
      }),
    ).toBe(false);
  });
});
