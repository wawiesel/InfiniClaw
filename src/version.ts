/** Resolved once at module load. Prefer stamped GIT_VERSION file over live git. */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

export const GIT_VERSION = (() => {
  const root = process.env.INFINICLAW_ROOT || process.cwd();
  // Prefer stamped file written by deployBot() — always reflects deployed commit
  try {
    const stamped = fs.readFileSync(path.join(root, 'GIT_VERSION'), 'utf-8').trim();
    if (stamped) return stamped;
  } catch { /* fall through to live git */ }
  // Fallback: live git query
  try {
    const hash = execSync('git rev-parse --short HEAD', { cwd: root, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    const date = execSync('git log -1 --format=%ci HEAD', { cwd: root, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim().slice(0, 10);
    const subject = execSync('git log -1 --format=%s HEAD', { cwd: root, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    return `${hash} (${date}) ${subject}`;
  } catch {
    return 'unknown';
  }
})();

/**
 * Get the latest semver git tag (`v*.*.*`) reachable from HEAD in the given repo.
 * Returns null if no semver tag exists.
 */
export function getLatestSemverTag(cwd: string): string | null {
  try {
    const tag = execSync('git describe --tags --match "v*.*.*" --abbrev=0', {
      cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return tag || null;
  } catch {
    return null;
  }
}

/**
 * Read the semver tag stamped at deploy time from a SEMVER_VERSION file.
 * Written by stampSemverVersion() in service.ts. Returns null if not stamped.
 */
export function getStampedSemverTag(instanceDir: string): string | null {
  try {
    const tag = fs.readFileSync(path.join(instanceDir, 'SEMVER_VERSION'), 'utf-8').trim();
    return tag || null;
  } catch {
    return null;
  }
}

/**
 * Get the latest semver tag reachable from a remote ref (e.g. origin/main).
 * Returns null if no semver tag exists on the ref.
 */
export function getLatestSemverTagOnRef(cwd: string, ref = 'origin/main'): string | null {
  try {
    const tag = execSync(`git describe --tags --match "v*.*.*" --abbrev=0 ${ref}`, {
      cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return tag || null;
  } catch {
    return null;
  }
}

/**
 * Count commits on a ref that are ahead of the latest semver tag.
 * Returns 0 if HEAD is at or behind the latest tag.
 */
export function commitsAheadOfTag(cwd: string, ref = 'origin/main'): number {
  const tag = getLatestSemverTagOnRef(cwd, ref);
  if (!tag) return 0;
  try {
    return parseInt(execSync(`git rev-list ${tag}..${ref} --count`, {
      cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim(), 10) || 0;
  } catch {
    return 0;
  }
}
