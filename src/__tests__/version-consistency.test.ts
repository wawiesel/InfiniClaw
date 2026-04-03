import fs from 'fs';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

function readText(relativePath: string): string {
  return fs.readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf-8');
}

describe('release version consistency', () => {
  it('keeps package.json, package-lock.json, and SEMVER_VERSION aligned', () => {
    const packageJson = JSON.parse(readText('../../package.json')) as { version: string };
    const packageLock = JSON.parse(readText('../../package-lock.json')) as {
      version: string;
      packages?: Record<string, { version?: string }>;
    };
    const semverVersion = readText('../../SEMVER_VERSION').trim();

    expect(semverVersion).toBe(`v${packageJson.version}`);
    expect(packageLock.version).toBe(packageJson.version);
    expect(packageLock.packages?.['']?.version).toBe(packageJson.version);
  });

  it('keeps the README banner version aligned with SEMVER_VERSION', () => {
    const semverVersion = readText('../../SEMVER_VERSION').trim();
    const readme = readText('../../README.md');
    const match = readme.match(/^# InfiniClaw (v\d+\.\d+\.\d+)$/m);

    expect(match?.[1]).toBe(semverVersion);
  });
});
