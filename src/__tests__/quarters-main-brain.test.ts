import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { syncPersistentClaudeMemory } from '../container-mounts.js';
import { resolveMainGroupFolder } from '../service.js';

const tmpDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

describe('resolveMainGroupFolder', () => {
  it('returns configured main group folder', () => {
    expect(resolveMainGroupFolder({ MAIN_GROUP_FOLDER: 'engineering' })).toBe('engineering');
  });

  it('falls back to main when unset or blank', () => {
    expect(resolveMainGroupFolder({})).toBe('main');
    expect(resolveMainGroupFolder({ MAIN_GROUP_FOLDER: '   ' })).toBe('main');
  });
});

describe('syncPersistentClaudeMemory', () => {
  it('migrates existing session memory into persistent storage and links current project dirs', () => {
    const dataDir = makeTempDir('quarters-main-memory-');
    const persistentMemoryDir = path.join(dataDir, 'persistent-memory');
    const currentClaudeDir = path.join(dataDir, 'sessions', 'engineering', '.claude');
    const oldClaudeDir = path.join(dataDir, 'sessions', 'main', '.claude');
    const currentProjectDir = path.join(currentClaudeDir, 'projects', '-workspace-persona-temp');
    const oldProjectDir = path.join(oldClaudeDir, 'projects', '-workspace-group');
    const currentMemoryDir = path.join(currentProjectDir, 'memory');
    const oldMemoryDir = path.join(oldProjectDir, 'memory');

    fs.mkdirSync(currentMemoryDir, { recursive: true });
    fs.mkdirSync(oldMemoryDir, { recursive: true });
    fs.writeFileSync(path.join(currentMemoryDir, 'MEMORY.md'), 'engineering memory\n');
    fs.writeFileSync(path.join(currentMemoryDir, 'project-sigkill.md'), 'engineering detail\n');
    fs.writeFileSync(path.join(oldMemoryDir, 'captain-preferences.md'), 'main detail\n');

    syncPersistentClaudeMemory(dataDir, currentClaudeDir, persistentMemoryDir);

    expect(fs.readFileSync(path.join(persistentMemoryDir, 'MEMORY.md'), 'utf-8')).toBe('engineering memory\n');
    expect(fs.readFileSync(path.join(persistentMemoryDir, 'project-sigkill.md'), 'utf-8')).toBe('engineering detail\n');
    expect(fs.readFileSync(path.join(persistentMemoryDir, 'captain-preferences.md'), 'utf-8')).toBe('main detail\n');

    const linkedMemory = path.join(currentProjectDir, 'memory');
    expect(fs.lstatSync(linkedMemory).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(linkedMemory)).toBe(fs.realpathSync(persistentMemoryDir));

    const legacyProjectMemory = path.join(currentClaudeDir, 'projects', '-workspace-group', 'memory');
    expect(fs.lstatSync(legacyProjectMemory).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(legacyProjectMemory)).toBe(fs.realpathSync(persistentMemoryDir));
  });
});
