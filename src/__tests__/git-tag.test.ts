import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { packageJsonVersion, tagVersionIfMissing, parseConventionalPrefix, bumpPackageJsonVersion, commitVersionBump } from '../git-utils.js';

// ── packageJsonVersion ─────────────────────────────────────────────

describe('packageJsonVersion', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-pkg-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns prefixed version tag from package.json', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ version: '1.15.0' }));
    expect(packageJsonVersion(tmpDir)).toBe('v1.15.0');
  });

  it('returns null if package.json is missing', () => {
    expect(packageJsonVersion(tmpDir)).toBeNull();
  });

  it('returns null if version field is missing', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'test' }));
    expect(packageJsonVersion(tmpDir)).toBeNull();
  });

  it('returns null if version is not a string', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ version: 123 }));
    expect(packageJsonVersion(tmpDir)).toBeNull();
  });

  it('returns null if version is an empty string', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ version: '' }));
    expect(packageJsonVersion(tmpDir)).toBeNull();
  });

  it('returns null if package.json is invalid JSON', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), 'not json');
    expect(packageJsonVersion(tmpDir)).toBeNull();
  });
});

// ── tagVersionIfMissing ────────────────────────────────────────────

function initTestRepo(repoDir: string, bareDir: string): void {
  const gitEnv = { GIT_CONFIG_NOSYSTEM: '1', HOME: repoDir };
  const run = (cmd: string, cwd: string) =>
    execSync(cmd, { cwd, stdio: 'pipe', env: { ...process.env, ...gitEnv } });

  run('git init --bare', bareDir);
  run('git init', repoDir);
  run(`git remote add origin ${bareDir}`, repoDir);
  run('git config user.email "test@test.com"', repoDir);
  run('git config user.name "Test"', repoDir);
}

function commitAndPush(repoDir: string, version: string): void {
  const gitEnv = { GIT_CONFIG_NOSYSTEM: '1', HOME: repoDir };
  const run = (cmd: string) =>
    execSync(cmd, { cwd: repoDir, stdio: 'pipe', env: { ...process.env, ...gitEnv } });

  fs.writeFileSync(path.join(repoDir, 'package.json'), JSON.stringify({ version }));
  run('git add package.json');
  run(`git commit -m "version bump ${version}"`);
  run('git push -u origin HEAD:main');
}

describe('tagVersionIfMissing', () => {
  let repoDir: string;
  let bareDir: string;

  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-repo-'));
    bareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-bare-'));
    initTestRepo(repoDir, bareDir);
    commitAndPush(repoDir, '1.15.0');
  });

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(bareDir, { recursive: true, force: true });
  });

  it('creates and pushes tag for current package.json version', () => {
    const tagged = tagVersionIfMissing(repoDir);
    expect(tagged).toBe('v1.15.0');

    // Verify tag exists locally
    const tags = execSync('git tag -l', { cwd: repoDir, encoding: 'utf-8' }).trim();
    expect(tags).toContain('v1.15.0');

    // Verify tag was pushed to bare remote
    const remoteTags = execSync('git tag -l', { cwd: bareDir, encoding: 'utf-8' }).trim();
    expect(remoteTags).toContain('v1.15.0');
  });

  it('returns null if tag already exists locally', () => {
    execSync(`git tag -a v1.15.0 -m "Release v1.15.0"`, {
      cwd: repoDir,
      stdio: 'pipe',
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: repoDir },
    });
    const tagged = tagVersionIfMissing(repoDir);
    expect(tagged).toBeNull();
  });

  it('returns null if package.json has no version field', () => {
    fs.writeFileSync(path.join(repoDir, 'package.json'), JSON.stringify({ name: 'test' }));
    const tagged = tagVersionIfMissing(repoDir);
    expect(tagged).toBeNull();
  });

  it('returns null if package.json does not exist', () => {
    fs.unlinkSync(path.join(repoDir, 'package.json'));
    const tagged = tagVersionIfMissing(repoDir);
    expect(tagged).toBeNull();
  });

  it('does not create duplicate tags on repeated calls', () => {
    tagVersionIfMissing(repoDir);
    const secondResult = tagVersionIfMissing(repoDir);
    expect(secondResult).toBeNull();

    // Only one tag should exist
    const tags = execSync('git tag -l v1.15.0', { cwd: repoDir, encoding: 'utf-8' }).trim().split('\n').filter(Boolean);
    expect(tags).toHaveLength(1);
  });
});

// ── parseConventionalPrefix ────────────────────────────────────────

describe('parseConventionalPrefix', () => {
  it('returns fix for fix: prefix', () => {
    expect(parseConventionalPrefix('fix: correct null check')).toBe('fix');
  });

  it('returns fix for fix(scope): prefix', () => {
    expect(parseConventionalPrefix('fix(auth): handle expired tokens')).toBe('fix');
  });

  it('returns feat for feat: prefix', () => {
    expect(parseConventionalPrefix('feat: add version bump')).toBe('feat');
  });

  it('returns feat for feat(scope): prefix', () => {
    expect(parseConventionalPrefix('feat(relay): auto-bump on merge')).toBe('feat');
  });

  it('returns breaking for breaking: prefix', () => {
    expect(parseConventionalPrefix('breaking: remove legacy API')).toBe('breaking');
  });

  it('returns breaking for breaking change: prefix', () => {
    expect(parseConventionalPrefix('breaking change: new config format')).toBe('breaking');
  });

  it('returns null for titles without conventional prefix', () => {
    expect(parseConventionalPrefix('WBS 51: implement version bump')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseConventionalPrefix('')).toBeNull();
  });

  it('is case-insensitive', () => {
    expect(parseConventionalPrefix('FIX: capitalised')).toBe('fix');
    expect(parseConventionalPrefix('FEAT: capitalised')).toBe('feat');
  });
});

// ── bumpPackageJsonVersion ─────────────────────────────────────────

describe('bumpPackageJsonVersion', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-bump-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('bumps patch for fix', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ version: '1.2.3' }));
    expect(bumpPackageJsonVersion(tmpDir, 'fix')).toBe('1.2.4');
    const pkg = JSON.parse(fs.readFileSync(path.join(tmpDir, 'package.json'), 'utf-8')) as { version: string };
    expect(pkg.version).toBe('1.2.4');
  });

  it('bumps minor and resets patch for feat', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ version: '1.2.3' }));
    expect(bumpPackageJsonVersion(tmpDir, 'feat')).toBe('1.3.0');
  });

  it('bumps major and resets minor/patch for breaking', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ version: '1.2.3' }));
    expect(bumpPackageJsonVersion(tmpDir, 'breaking')).toBe('2.0.0');
  });

  it('returns null if package.json is missing', () => {
    expect(bumpPackageJsonVersion(tmpDir, 'fix')).toBeNull();
  });
});

// ── commitVersionBump ──────────────────────────────────────────────

describe('commitVersionBump', () => {
  let repoDir: string;
  let bareDir: string;

  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-repo-'));
    bareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-bare-'));
    initTestRepo(repoDir, bareDir);
    commitAndPush(repoDir, '1.2.3');
  });

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(bareDir, { recursive: true, force: true });
  });

  it('commits bumped version, creates tag, and pushes to origin', () => {
    bumpPackageJsonVersion(repoDir, 'fix');
    commitVersionBump(repoDir, '1.2.4');

    // Tag exists locally
    const tags = execSync('git tag -l v1.2.4', { cwd: repoDir, encoding: 'utf-8' }).trim();
    expect(tags).toContain('v1.2.4');

    // Tag pushed to bare remote
    const remoteTags = execSync('git tag -l v1.2.4', { cwd: bareDir, encoding: 'utf-8' }).trim();
    expect(remoteTags).toContain('v1.2.4');

    // Commit message contains new version
    const log = execSync('git log -1 --format=%s', { cwd: repoDir, encoding: 'utf-8' }).trim();
    expect(log).toBe('chore: bump version to v1.2.4');
  });
});
