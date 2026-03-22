import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { truncateJsonl } from './session-utils.js';

const line = (obj: object) => JSON.stringify(obj);

function makeTmpFile(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-utils-test-'));
  const filePath = path.join(dir, 'test.jsonl');
  fs.writeFileSync(filePath, content);
  return filePath;
}

describe('truncateJsonl', () => {
  it('returns 0 and leaves file unchanged when under targetBytes', () => {
    const content = line({ type: 'user', text: 'hello' }) + '\n';
    const filePath = makeTmpFile(content);
    const removed = truncateJsonl(filePath, 10_000);
    expect(removed).toBe(0);
    expect(fs.readFileSync(filePath, 'utf-8')).toBe(content);
  });

  it('truncates older conversation entries when file exceeds targetBytes', () => {
    const old1 = line({ type: 'user', text: 'old message 1' });
    const old2 = line({ type: 'assistant', text: 'old reply 1' });
    const recent1 = line({ type: 'user', text: 'recent message' });
    const recent2 = line({ type: 'assistant', text: 'recent reply' });
    const content = [old1, old2, recent1, recent2].join('\n') + '\n';
    const filePath = makeTmpFile(content);

    // Target: just big enough for recent lines but not old ones
    const targetBytes = recent1.length + recent2.length + 10;
    const removed = truncateJsonl(filePath, targetBytes);

    expect(removed).toBeGreaterThan(0);
    const result = fs.readFileSync(filePath, 'utf-8');
    expect(result).toContain('recent message');
    expect(result).toContain('recent reply');
    expect(result).not.toContain('old message 1');
    expect(result).not.toContain('old reply 1');
  });

  it('preserves metadata (queue-operation, summary) lines regardless of position', () => {
    const meta = line({ type: 'summary', content: 'session summary' });
    const old1 = line({ type: 'user', text: 'old 1' });
    const old2 = line({ type: 'user', text: 'old 2' });
    const recent = line({ type: 'user', text: 'recent' });
    const content = [meta, old1, old2, recent].join('\n') + '\n';
    const filePath = makeTmpFile(content);

    const targetBytes = meta.length + recent.length + 10;
    const removed = truncateJsonl(filePath, targetBytes);

    expect(removed).toBeGreaterThan(0);
    const result = fs.readFileSync(filePath, 'utf-8');
    expect(result).toContain('session summary');
    expect(result).toContain('recent');
    expect(result).not.toContain('old 1');
    expect(result).not.toContain('old 2');
  });

  it('preserves last-prompt tail line', () => {
    const old1 = line({ type: 'user', text: 'old message' });
    const recent = line({ type: 'user', text: 'recent' });
    const lastPrompt = line({ type: 'last-prompt', prompt: 'do something' });
    const content = [old1, recent, lastPrompt].join('\n') + '\n';
    const filePath = makeTmpFile(content);

    const targetBytes = recent.length + lastPrompt.length + 10;
    truncateJsonl(filePath, targetBytes);

    const result = fs.readFileSync(filePath, 'utf-8');
    expect(result).toContain('last-prompt');
    expect(result).toContain('do something');
  });

  it('preserves the file on disk even when target is impossibly small', () => {
    // With an impossibly small target the conversation is cleared, but the file
    // itself is NOT deleted — this is the key difference from the old behaviour
    // which would call fs.unlinkSync and wipe the session entirely.
    const only = line({ type: 'user', text: 'only message' });
    const content = only + '\n';
    const filePath = makeTmpFile(content);

    truncateJsonl(filePath, 5); // impossibly small target
    // File must still exist — never deleted
    expect(fs.existsSync(filePath)).toBe(true);
  });
});
