import { execSync } from 'child_process';

/** Warn thresholds for OAuth token expiry. */
const TOKEN_EXPIRY_WARN_DAYS = 7;
const TOKEN_EXPIRY_CRIT_DAYS = 1;

export function resolveOAuthToken(): string {
  try {
    const credJson = execSync(
      'security find-generic-password -s "Claude Code-credentials" -w',
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
    ).trim();
    if (!credJson) return '';
    const parsed = JSON.parse(credJson);
    const oauth = parsed?.claudeAiOauth;
    if (!oauth?.accessToken) return '';

    checkTokenExpiry(oauth.expiresAt);
    return oauth.accessToken;
  } catch {
    return '';
  }
}

function checkTokenExpiry(expiresAt: number | undefined): void {
  if (!expiresAt) return;
  const now = Date.now();
  const remaining = expiresAt - now;
  const days = remaining / (1000 * 60 * 60 * 24);

  if (remaining <= 0) {
    console.error(
      `\x1b[31m[AUTH] OAuth token EXPIRED ${Math.abs(Math.round(days))} day(s) ago. ` +
      `Run \`claude setup-token\` to renew.\x1b[0m`,
    );
  } else if (days <= TOKEN_EXPIRY_CRIT_DAYS) {
    console.error(
      `\x1b[31m[AUTH] OAuth token expires in ${Math.round(days * 24)} hours. ` +
      `Run \`claude setup-token\` to renew.\x1b[0m`,
    );
  } else if (days <= TOKEN_EXPIRY_WARN_DAYS) {
    console.warn(
      `\x1b[33m[AUTH] OAuth token expires in ${Math.round(days)} day(s). ` +
      `Run \`claude setup-token\` to renew.\x1b[0m`,
    );
  }
}
