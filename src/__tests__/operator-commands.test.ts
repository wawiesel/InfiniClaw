import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { vi } from 'vitest';
import fs from 'fs';
import path from 'path';

const { TEST_DATA_DIR } = vi.hoisted(() => ({
  TEST_DATA_DIR: '/tmp/infiniclaw-test-' + process.pid,
}));

vi.mock('nanoclaw/config.js', async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    DATA_DIR: TEST_DATA_DIR,
  };
});

import { _initTestDatabase, setSession, setRegisteredGroup } from 'nanoclaw/db.js';
import { readTodoItems, buildTodoMessage } from '../operator-commands.js';

// ── readTodoItems ──────────────────────────────────────────────────

describe('readTodoItems', () => {
  const FOLDER = 'test-group';
  const SESSION_ID = 'test-session-abc';

  beforeEach(() => {
    _initTestDatabase();
    setSession(FOLDER, SESSION_ID);
    const todosDir = path.join(TEST_DATA_DIR, 'sessions', FOLDER, '.claude', 'todos');
    fs.mkdirSync(todosDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });

  function writeTodos(data: unknown): void {
    const todosDir = path.join(TEST_DATA_DIR, 'sessions', FOLDER, '.claude', 'todos');
    const filePath = path.join(todosDir, `${SESSION_ID}-agent-${SESSION_ID}.json`);
    fs.writeFileSync(filePath, JSON.stringify(data));
  }

  it('returns empty array when todos directory does not exist', () => {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    expect(readTodoItems(FOLDER)).toEqual([]);
  });

  it('returns empty array when no session exists in DB', () => {
    _initTestDatabase(); // fresh DB, no session
    expect(readTodoItems(FOLDER)).toEqual([]);
  });

  it('returns empty array when todo file does not exist', () => {
    // Session set but no file written
    expect(readTodoItems(FOLDER)).toEqual([]);
  });

  it('returns empty array for empty JSON array', () => {
    writeTodos([]);
    expect(readTodoItems(FOLDER)).toEqual([]);
  });

  it('returns empty array for empty string file', () => {
    const todosDir = path.join(TEST_DATA_DIR, 'sessions', FOLDER, '.claude', 'todos');
    fs.writeFileSync(path.join(todosDir, `${SESSION_ID}-agent-${SESSION_ID}.json`), '');
    expect(readTodoItems(FOLDER)).toEqual([]);
  });

  it('returns empty array for invalid JSON', () => {
    const todosDir = path.join(TEST_DATA_DIR, 'sessions', FOLDER, '.claude', 'todos');
    fs.writeFileSync(path.join(todosDir, `${SESSION_ID}-agent-${SESSION_ID}.json`), 'not json');
    expect(readTodoItems(FOLDER)).toEqual([]);
  });

  it('returns empty array for non-array JSON', () => {
    writeTodos({ not: 'an array' });
    expect(readTodoItems(FOLDER)).toEqual([]);
  });

  it('parses valid todo items', () => {
    writeTodos([
      { content: 'Fix the bug', status: 'in_progress' },
      { content: 'Write tests', status: 'pending' },
      { content: 'Deploy', status: 'completed' },
    ]);

    const items = readTodoItems(FOLDER);
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ content: 'Fix the bug', status: 'in_progress' });
    expect(items[1]).toMatchObject({ content: 'Write tests', status: 'pending' });
    expect(items[2]).toMatchObject({ content: 'Deploy', status: 'completed' });
  });

  it('filters out items missing content field', () => {
    writeTodos([
      { content: 'Valid', status: 'pending' },
      { status: 'pending' },
    ]);
    expect(readTodoItems(FOLDER)).toHaveLength(1);
    expect(readTodoItems(FOLDER)[0].content).toBe('Valid');
  });

  it('filters out items missing status field', () => {
    writeTodos([
      { content: 'No status' },
      { content: 'Has status', status: 'in_progress' },
    ]);
    expect(readTodoItems(FOLDER)).toHaveLength(1);
    expect(readTodoItems(FOLDER)[0].content).toBe('Has status');
  });

  it('filters out non-object entries', () => {
    writeTodos([null, 'string', 42, { content: 'Good', status: 'pending' }]);
    expect(readTodoItems(FOLDER)).toHaveLength(1);
    expect(readTodoItems(FOLDER)[0].content).toBe('Good');
  });

  it('preserves activeForm field', () => {
    writeTodos([{ content: 'Working on it', status: 'in_progress', activeForm: 'Building image' }]);
    const items = readTodoItems(FOLDER);
    expect(items[0].activeForm).toBe('Building image');
  });
});

// ── buildTodoMessage ───────────────────────────────────────────────

describe('buildTodoMessage', () => {
  const CHAT_JID = 'eng@matrix.org';
  const FOLDER = 'engineering';
  const SESSION_ID = 'session-eng';

  beforeEach(() => {
    _initTestDatabase();
    setRegisteredGroup(CHAT_JID, {
      name: 'Engineering',
      folder: FOLDER,
      trigger: '@Cid',
      added_at: '2024-01-01T00:00:00.000Z',
    });
    setSession(FOLDER, SESSION_ID);

    const todosDir = path.join(TEST_DATA_DIR, 'sessions', FOLDER, '.claude', 'todos');
    fs.mkdirSync(todosDir, { recursive: true });
    const ipcDir = path.join(TEST_DATA_DIR, 'ipc', FOLDER);
    fs.mkdirSync(ipcDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });

  function writeTodos(data: unknown): void {
    const todosDir = path.join(TEST_DATA_DIR, 'sessions', FOLDER, '.claude', 'todos');
    fs.writeFileSync(
      path.join(todosDir, `${SESSION_ID}-agent-${SESSION_ID}.json`),
      JSON.stringify(data),
    );
  }

  function writeStatus(data: unknown): void {
    const ipcDir = path.join(TEST_DATA_DIR, 'ipc', FOLDER);
    fs.writeFileSync(path.join(ipcDir, 'status.json'), JSON.stringify(data));
  }

  it('returns "Room not registered" for unknown JID', () => {
    const msg = buildTodoMessage('unknown@matrix.org');
    expect(msg).toContain('Room not registered');
  });

  it('shows "No active tasks" when todo list is empty', () => {
    const msg = buildTodoMessage(CHAT_JID);
    expect(msg).toContain('No active tasks');
    expect(msg).toContain('Engineering');
  });

  it('shows todo items with status icons', () => {
    writeTodos([
      { content: 'Fix bug', status: 'in_progress' },
      { content: 'Write docs', status: 'pending' },
      { content: 'Done thing', status: 'completed' },
    ]);

    const msg = buildTodoMessage(CHAT_JID);
    expect(msg).toContain('🔧 Fix bug');
    expect(msg).toContain('⏳ Write docs');
    expect(msg).toContain('✅ Done thing');
  });

  it('shows idle when no status file exists', () => {
    const msg = buildTodoMessage(CHAT_JID);
    expect(msg).toContain('Currently: idle');
  });

  it('shows active status with lastProgress', () => {
    writeStatus({
      groups: [{ folder: FOLDER, active: true, lastProgress: 'Building container image' }],
    });

    const msg = buildTodoMessage(CHAT_JID);
    expect(msg).toContain('Currently: Building container image');
  });

  it('shows currentObjective when lastProgress is absent', () => {
    writeStatus({
      groups: [{ folder: FOLDER, active: true, currentObjective: 'Fixing mount validation' }],
    });

    const msg = buildTodoMessage(CHAT_JID);
    expect(msg).toContain('Currently: Fixing mount validation');
  });
});
