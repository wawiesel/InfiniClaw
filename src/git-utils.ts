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
 * Read the version from package.json in dir and return it as a tag string (e.g. "v1.15.0").
 * Returns null if the file is missing, invalid JSON, or has no valid non-empty string version.
 */
export function packageJsonVersion(dir: string): string | null {
  try {
    const raw = fs.readFileSync(path.join(dir, 'package.json'), 'utf-8');
    const pkg = JSON.parse(raw) as unknown;
    if (typeof pkg !== 'object' || pkg === null) return null;
    const v = (pkg as Record<string, unknown>).version;
    if (typeof v !== 'string' || v === '') return null;
    return `v${v}`;
  } catch {
    return null;
  }
}

/**
 * Parse a conventional commit prefix from a PR title.
 * Returns 'breaking', 'feat', or 'fix', or null if no conventional prefix is found.
 * Matches: "breaking:", "breaking change:", "feat:", "feat(scope):", "fix:", "fix(scope):"
 */
export function parseConventionalPrefix(title: string): 'fix' | 'feat' | 'breaking' | null {
  const lower = title.toLowerCase().trimStart();
  if (/^breaking(\s+change)?[!:]/.test(lower)) return 'breaking';
  if (/^feat(\([^)]*\))?!?:/.test(lower)) return 'feat';
  if (/^fix(\([^)]*\))?!?:/.test(lower)) return 'fix';
  return null;
}

/**
 * Bump the version in package.json according to the bump type.
 * breaking → major bump (minor and patch reset to 0)
 * feat     → minor bump (patch reset to 0)
 * fix      → patch bump
 * Returns the new version string (without 'v' prefix), or null on failure.
 */
export function bumpPackageJsonVersion(dir: string, bumpType: 'fix' | 'feat' | 'breaking'): string | null {
  try {
    const pkgPath = path.join(dir, 'package.json');
    const raw = fs.readFileSync(pkgPath, 'utf-8');
    const pkg = JSON.parse(raw) as Record<string, unknown>;
    const current = typeof pkg.version === 'string' && pkg.version ? pkg.version : '0.0.0';
    const [majorStr = '0', minorStr = '0', patchStr = '0'] = current.split('.');
    let major = parseInt(majorStr, 10) || 0;
    let minor = parseInt(minorStr, 10) || 0;
    let patch = parseInt(patchStr, 10) || 0;
    if (bumpType === 'breaking') { major++; minor = 0; patch = 0; }
    else if (bumpType === 'feat') { minor++; patch = 0; }
    else { patch++; }
    const newVersion = `${major}.${minor}.${patch}`;
    pkg.version = newVersion;
    // Preserve trailing newline if original had one
    const trailing = raw.endsWith('\n') ? '\n' : '';
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + trailing);
    return newVersion;
  } catch {
    return null;
  }
}

/**
 * Commit a version bump to package.json, create an annotated semver tag, and push both to origin main.
 * Caller is responsible for ensuring the working tree is on main and package.json is already bumped.
 * Throws on git failure — wrap in try/catch for best-effort behavior.
 */
export function commitVersionBump(dir: string, newVersion: string): void {
  const opts = gitOpts(dir, 30_000);
  const tag = `v${newVersion}`;
  execSync('git add package.json', opts);
  execSync(`git commit -m "chore: bump version to ${tag}"`, opts);
  execSync(`git tag -a ${tag} -m "Release ${tag}"`, opts);
  execSync('git push origin HEAD:main', opts);
  try { execSync(`git push origin ${tag}`, opts); } catch { /* best effort tag push */ }
}

/**
 * If the version tag from package.json doesn't exist locally, create an annotated tag and push it.
 * Returns the tag name if a new tag was created, null if tag already exists or no version found.
 */
export function tagVersionIfMissing(dir: string): string | null {
  const tag = packageJsonVersion(dir);
  if (!tag) return null;
  const opts = gitOpts(dir);
  const existing = execSync(`git tag -l ${tag}`, opts).trim();
  if (existing) return null;
  execSync(`git tag -a ${tag} -m "Release ${tag}"`, opts);
  try {
    execSync(`git push origin ${tag}`, opts);
  } catch { /* best effort push */ }
  return tag;
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
  execSync('git fetch origin --tags --force', opts);
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
