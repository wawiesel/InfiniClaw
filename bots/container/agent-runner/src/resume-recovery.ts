export function isResumePoisonedApiError(result: string | undefined): boolean {
  if (!result) return false;
  const text = result.trim();
  if (!text.startsWith('API Error:')) return false;
  return (
    text.includes('"type":"invalid_request_error"') ||
    text.includes('"message":"Bad Request"') ||
    /\bBad Request\b/.test(text)
  );
}

export function shouldRetryWithoutResume(args: {
  hadSession: boolean;
  exitCode: number | null;
  interrupted: boolean;
  closedDuringRun: boolean;
  result?: string;
}): boolean {
  return Boolean(
    args.hadSession &&
    args.exitCode !== 0 &&
    !args.interrupted &&
    !args.closedDuringRun &&
    (!args.result || isResumePoisonedApiError(args.result))
  );
}
