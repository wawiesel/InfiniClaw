import { execSync } from 'child_process';

/** Shared formatting utilities for chat messages. */

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Format a status message: emoji plain, text in italic grey.
 *  Must start with `<` so Matrix channel detects it as preformatted HTML. */
export function statusMessage(emoji: string, text: string): string {
  return `<font color="#888888">${escapeHtml(emoji)} <em>${escapeHtml(text)}</em></font>`;
}

/** Standard version string format: · 📦 [`sha`](https://github.com/wawiesel/InfiniClaw/commit/sha) (age) ↑N */
export function getGitVersionStr(root: string, sha: string, relation: string, GITHUB_REPO_URL: string): string {
  const ageMs = getCommitAge(root, sha);
  const url = `${GITHUB_REPO_URL}/commit/${sha}`;
  return ` · 📦 [\`${sha}\`](${url}) (${formatDuration(ageMs)}) ${relation}`;
}

function getCommitAge(root: string, sha: string): number {
  try {
    const epoch = parseInt(execSync(`git log -1 --format=%ct ${sha}`, { cwd: root, encoding: 'utf-8', stdio: 'pipe' }).trim(), 10) * 1000;
    return Date.now() - epoch;
  } catch { return 0; }
}

function formatDuration(ms: number): string {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min}m`;
  const hrs = (ms / 3_600_000).toFixed(1).replace(/\.0$/, '');
  return `${hrs}h`;
}
