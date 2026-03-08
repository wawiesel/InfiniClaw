import { execSync, execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { errStr, resolveRoot } from './utils.js';
import { logger } from 'nanoclaw/logger.js';

export function getGitRelation(root: string, local: string, upstream: string): string {
  const execOpts = { encoding: 'utf-8' as const, timeout: 5_000, stdio: 'pipe' as const, cwd: root };
  try {
    const ahead = parseInt(execSync(`git rev-list ${upstream}..${local} --count`, execOpts).trim(), 10) || 0;
    const behind = parseInt(execSync(`git rev-list ${local}..${upstream} --count`, execOpts).trim(), 10) || 0;
    if (ahead > 0 && behind > 0) return `↑${ahead}↓${behind}`;
    if (ahead > 0) return `↑${ahead}`;
    if (behind > 0) return `↓${behind}`;
    return '↑0';
  } catch { return 'unknown'; }
}

export function getCommitAge(root: string, sha: string): number {
  const execOpts = { encoding: 'utf-8' as const, timeout: 5_000, stdio: 'pipe' as const, cwd: root };
  try {
    const epoch = parseInt(execSync(`git log -1 --format=%ct ${sha}`, execOpts).trim(), 10) * 1000;
    return Date.now() - epoch;
  } catch { return 0; }
}

export function getRepoVersion(repoDir: string, GITHUB_REPO_URL: string): string {
  try {
    const execOpts = { encoding: 'utf-8' as const, timeout: 5_000, stdio: 'pipe' as const, cwd: repoDir };
    const sha = execSync('git rev-parse --short HEAD', execOpts).trim();
    if (!sha) return '';
    const age = getCommitAge(repoDir, sha);
    const rel = getGitRelation(repoDir, 'HEAD', 'origin/main');
    const url = `${GITHUB_REPO_URL}/commit/${sha}`;
    return ` · 📦 [${sha}](${url}) (${formatDuration(age)}) ${rel}`;
  } catch { return ''; }
}

function formatDuration(ms: number): string {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min}m`;
  const hrs = (ms / 3_600_000).toFixed(1).replace(/\.0$/, '');
  return `${hrs}h`;
}

export function gitSync(root: string): { ok: boolean; output: string; newCommits: number } {
  const execOpts = { cwd: root, encoding: 'utf-8' as const, timeout: 30_000, stdio: 'pipe' as const };
  try {
    if (fs.existsSync(path.join(root, '.git', 'REBASE_HEAD'))) {
      try { execSync('git rebase --abort', execOpts); } catch { /* ignore */ }
    }
    execSync('git fetch origin', execOpts);
    const newCommits = parseInt(execSync('git rev-list HEAD..origin/main --count', execOpts).trim(), 10) || 0;
    if (newCommits === 0) return { ok: true, output: 'up to date', newCommits: 0 };
    
    // Simple pull --rebase for now, can add more complex logic if needed
    execSync('git pull --rebase origin main', execOpts);
    return { ok: true, output: 'pulled', newCommits };
  } catch (err) {
    return { ok: false, output: errStr(err), newCommits: -1 };
  }
}
