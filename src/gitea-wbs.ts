/**
 * WBS → Gitea issue/PR pipeline.
 *
 * Hooks:
 *   - WBS item → in_progress : create a Gitea issue, store its number in item.gitea_issue
 *   - BB pushes a branch     : create a PR linked to the Gitea issue
 *   - WBS item → done        : close the Gitea issue
 *
 * All operations are best-effort (non-fatal). Failures are logged and swallowed so
 * the WBS state machine is never blocked by Gitea being unavailable.
 */
import fs from 'fs';
import path from 'path';
import { logger } from 'nanoclaw/logger.js';
import { loadShipConfig } from './ship-config.js';
import type { WbsItem } from './wbs.js';

const GITEA_REPO = 'wawiesel/infiniclaw';

// ── Config ────────────────────────────────────────────────────────────────────

/** Load Gitea admin config from secrets repo. Returns null if not configured. */
export function loadGiteaAdminConfig(): { url: string; token: string } | null {
  try {
    const secretsPath = loadShipConfig().secretsPath;
    const p = path.join(secretsPath, 'operator', 'gitea.json');
    const data = JSON.parse(fs.readFileSync(p, 'utf-8')) as Record<string, unknown>;
    if (typeof data.url === 'string' && typeof data.api_token === 'string' && data.url && data.api_token) {
      return { url: data.url, token: data.api_token };
    }
    return null;
  } catch { return null; }
}

function giteaHeaders(token: string): Record<string, string> {
  return { Authorization: `token ${token}`, 'Content-Type': 'application/json' };
}

// ── Issue lifecycle ───────────────────────────────────────────────────────────

/**
 * Create a Gitea issue for a WBS item that has just moved to in_progress.
 * Returns the new issue number, or null on failure.
 */
export async function giteaCreateIssueForWbs(item: WbsItem, room: string): Promise<number | null> {
  const gitea = loadGiteaAdminConfig();
  if (!gitea) return null;

  const bodyLines = [
    `**WBS item**: \`${item.id}\``,
    `**Room**: ${room}`,
    `**Assigned to**: ${item.assigned_to ?? 'unassigned'}`,
    ...(item.source ? [`**Source**: ${item.source}`] : []),
    '',
    'Auto-created when WBS item moved to in_progress.',
  ];

  try {
    const resp = await fetch(`${gitea.url}/api/v1/repos/${GITEA_REPO}/issues`, {
      method: 'POST',
      headers: giteaHeaders(gitea.token),
      body: JSON.stringify({ title: `WBS ${item.id}: ${item.title}`, body: bodyLines.join('\n') }),
    });
    if (!resp.ok) {
      logger.warn({ status: resp.status, wbsId: item.id }, 'gitea-wbs: failed to create issue');
      return null;
    }
    const data = await resp.json() as { number: number };
    logger.info({ issueNumber: data.number, wbsId: item.id }, 'gitea-wbs: issue created');
    return data.number;
  } catch (err) {
    logger.warn({ err, wbsId: item.id }, 'gitea-wbs: createIssue threw');
    return null;
  }
}

/**
 * Close a Gitea issue when the corresponding WBS item is marked done.
 */
export async function giteaCloseIssue(issueNumber: number): Promise<void> {
  const gitea = loadGiteaAdminConfig();
  if (!gitea) return;
  try {
    const resp = await fetch(`${gitea.url}/api/v1/repos/${GITEA_REPO}/issues/${issueNumber}`, {
      method: 'PATCH',
      headers: giteaHeaders(gitea.token),
      body: JSON.stringify({ state: 'closed' }),
    });
    if (!resp.ok) {
      logger.warn({ status: resp.status, issueNumber }, 'gitea-wbs: failed to close issue');
      return;
    }
    logger.info({ issueNumber }, 'gitea-wbs: issue closed');
  } catch (err) {
    logger.warn({ err, issueNumber }, 'gitea-wbs: closeIssue threw');
  }
}

// ── Standalone issue + comment (GDS) ─────────────────────────────────────────

/**
 * Create a standalone Gitea issue (not tied to WBS in_progress transition).
 * Returns the new issue number, or null on failure.
 */
export async function giteaCreateIssue(title: string, body: string): Promise<number | null> {
  const gitea = loadGiteaAdminConfig();
  if (!gitea) return null;
  try {
    const resp = await fetch(`${gitea.url}/api/v1/repos/${GITEA_REPO}/issues`, {
      method: 'POST',
      headers: giteaHeaders(gitea.token),
      body: JSON.stringify({ title, body }),
    });
    if (!resp.ok) {
      logger.warn({ status: resp.status, title }, 'gitea: failed to create issue');
      return null;
    }
    const data = await resp.json() as { number: number };
    logger.info({ issueNumber: data.number, title }, 'gitea: issue created');
    return data.number;
  } catch (err) {
    logger.warn({ err, title }, 'gitea: createIssue threw');
    return null;
  }
}

/**
 * Post a comment on a Gitea issue. Returns comment ID or null on failure.
 */
export async function giteaCommentOnIssue(issueNumber: number, body: string): Promise<number | null> {
  const gitea = loadGiteaAdminConfig();
  if (!gitea) return null;
  try {
    const resp = await fetch(`${gitea.url}/api/v1/repos/${GITEA_REPO}/issues/${issueNumber}/comments`, {
      method: 'POST',
      headers: giteaHeaders(gitea.token),
      body: JSON.stringify({ body }),
    });
    if (!resp.ok) {
      logger.warn({ status: resp.status, issueNumber }, 'gitea: failed to comment on issue');
      return null;
    }
    const data = await resp.json() as { id: number };
    logger.info({ commentId: data.id, issueNumber }, 'gitea: comment posted');
    return data.id;
  } catch (err) {
    logger.warn({ err, issueNumber }, 'gitea: commentOnIssue threw');
    return null;
  }
}

/**
 * Update a Gitea issue body (replace entire body content).
 */
export async function giteaUpdateIssueBody(issueNumber: number, body: string): Promise<void> {
  const gitea = loadGiteaAdminConfig();
  if (!gitea) return;
  try {
    const resp = await fetch(`${gitea.url}/api/v1/repos/${GITEA_REPO}/issues/${issueNumber}`, {
      method: 'PATCH',
      headers: giteaHeaders(gitea.token),
      body: JSON.stringify({ body }),
    });
    if (!resp.ok) {
      logger.warn({ status: resp.status, issueNumber }, 'gitea: failed to update issue body');
    }
  } catch (err) {
    logger.warn({ err, issueNumber }, 'gitea: updateIssueBody threw');
  }
}

/**
 * Get reactions on a Gitea issue. Returns array of { user: login, content: emoji }.
 */
export async function giteaGetIssueReactions(issueNumber: number): Promise<{ user: string; content: string }[]> {
  const gitea = loadGiteaAdminConfig();
  if (!gitea) return [];
  try {
    const resp = await fetch(`${gitea.url}/api/v1/repos/${GITEA_REPO}/issues/${issueNumber}/reactions`, {
      headers: giteaHeaders(gitea.token),
    });
    if (!resp.ok) return [];
    const data = await resp.json() as { user: { login: string }; content: string }[];
    return data.map(r => ({ user: r.user.login, content: r.content }));
  } catch { return []; }
}

/**
 * Remove a reaction from a Gitea issue (so it doesn't re-trigger).
 */
export async function giteaRemoveIssueReaction(issueNumber: number, content: string): Promise<void> {
  const gitea = loadGiteaAdminConfig();
  if (!gitea) return;
  try {
    await fetch(`${gitea.url}/api/v1/repos/${GITEA_REPO}/issues/${issueNumber}/reactions`, {
      method: 'DELETE',
      headers: giteaHeaders(gitea.token),
      body: JSON.stringify({ content }),
    });
  } catch { /* best effort */ }
}

// ── PR creation ───────────────────────────────────────────────────────────────

/**
 * Create a PR for a BB-pushed branch, optionally linked to a WBS Gitea issue.
 * Skips if the branch is main/master (no PR needed for direct pushes).
 */
export async function giteaCreatePrForBranch(opts: {
  branch: string;
  wbsId: string;
  itemTitle: string;
  issueNumber: number | null;
}): Promise<void> {
  const { branch, wbsId, itemTitle, issueNumber } = opts;
  if (branch === 'main' || branch === 'master') return;

  const gitea = loadGiteaAdminConfig();
  if (!gitea) return;

  const bodyParts = [
    issueNumber ? `Closes #${issueNumber}` : '',
    `**WBS**: ${wbsId}`,
  ].filter(Boolean);

  try {
    const resp = await fetch(`${gitea.url}/api/v1/repos/${GITEA_REPO}/pulls`, {
      method: 'POST',
      headers: giteaHeaders(gitea.token),
      body: JSON.stringify({
        title: `WBS ${wbsId}: ${itemTitle}`,
        head: branch,
        base: 'main',
        body: bodyParts.join('\n\n'),
      }),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      logger.warn({ status: resp.status, branch, text }, 'gitea-wbs: failed to create PR');
      return;
    }
    const pr = await resp.json() as { number: number; html_url: string };
    logger.info({ prNumber: pr.number, branch, url: pr.html_url }, 'gitea-wbs: PR created');
  } catch (err) {
    logger.warn({ err, branch }, 'gitea-wbs: createPr threw');
  }
}
