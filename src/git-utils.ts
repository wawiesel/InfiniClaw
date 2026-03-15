/** Git utilities shared across relay, ipc-commands, and service. */
import { execSync } from 'child_process';
import type { ExecSyncOptionsWithStringEncoding } from 'child_process';
import fs from 'fs';
import path from 'path';

/** Standard exec options for git commands. */
export function gitOpts(cwd: string, timeoutMs = 15_000): ExecSyncOptionsWithStringEncoding {
  return { cwd, encoding: 'utf-8', timeout: timeoutMs, stdio: 'pipe' };
}

/** Extract stdout+stderr from a caught execSync error. */
export function execErrOutput(err: unknown): string {
  if (!err || typeof err !== 'object') return '';
  const e = err as { stdout?: unknown; stderr?: unknown };
  const out = typeof e.stdout === 'string' ? e.stdout.trim() : '';
  const errText = typeof e.stderr === 'string' ? e.stderr.trim() : '';
  return [out, errText].filter(Boolean).join('\n');
}

/**
 * Fetch origin, then stash → rebase onto targetRef → pop stash.
 * On rebase conflict: aborts and hard-resets to targetRef (origin is authoritative).
 * @param targetRef - git ref to advance to (default: 'origin/main'). Can be a tag or commit.
 * Returns { pulled, changed, output }; pulled=0 means already up to date.
 */
export function gitSyncRepo(cwd: string, targetRef = 'origin/main'): { pulled: number; changed: boolean; output: string } {
  const opts = gitOpts(cwd, 30_000);
  // Abort any stuck rebase from a previous failed sync
  if (fs.existsSync(path.join(cwd, '.git', 'REBASE_HEAD'))) {
    try { execSync('git rebase --abort', opts); } catch { /* ignore */ }
  }
  execSync('git fetch origin --tags', opts);
  const pulled = parseInt(
    execSync(`git rev-list HEAD..${targetRef} --count`, { ...opts, timeout: 5_000 }).trim(),
    10,
  ) || 0;
  if (pulled === 0) return { pulled: 0, changed: false, output: 'up to date' };
  // Check if package-lock.json will change (caller may need to run npm install)
  let changed = false;
  try {
    const diff = execSync(`git diff HEAD..${targetRef} --name-only`, { ...opts, timeout: 5_000 }).trim();
    changed = diff.split('\n').includes('package-lock.json');
  } catch { /* best effort */ }
  // If there's an in-progress merge (e.g. from a previous conflict), abort it so git stash works
  if (fs.existsSync(path.join(cwd, '.git', 'MERGE_HEAD'))) {
    try { execSync('git merge --abort', opts); } catch { /* ignore */ }
  }
  // Stash any uncommitted changes
  let didStash = false;
  try {
    const out = execSync('git stash --include-untracked', opts).trim();
    didStash = !out.includes('No local changes');
  } catch (err) {
    const detail = execErrOutput(err);
    if (!detail.includes('No local changes')) {
      throw new Error(`git stash failed${detail ? `: ${detail}` : ''}`);
    }
  }
  let output = '';
  try {
    output = execSync(`git rebase ${targetRef}`, opts).trim();
  } catch {
    // Origin is authoritative — abort rebase and hard reset
    try { execSync('git rebase --abort', opts); } catch { /* ignore */ }
    execSync(`git reset --hard ${targetRef}`, opts);
    changed = true;
    output = `reset to ${targetRef} (rebase conflict auto-resolved)`;
  } finally {
    if (didStash) {
      try { execSync('git stash pop', opts); } catch { /* conflict — leave in stash */ }
    }
  }
  return { pulled, changed, output };
}
