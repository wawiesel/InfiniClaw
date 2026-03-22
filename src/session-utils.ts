import fs from 'fs';

/**
 * Truncate older JSONL entries to bring a session file under targetBytes.
 * Keeps session metadata lines (queue-operation, summary) and recent conversation
 * turns, discarding only older middle entries. The session ID (filename) is preserved
 * so the bot can resume with recent context intact.
 * Returns bytes removed, or 0 if no truncation was needed or possible.
 */
export function truncateJsonl(filePath: string, targetBytes: number): number {
  const content = fs.readFileSync(filePath, 'utf-8');
  if (content.length <= targetBytes) return 0;

  const lines = content.split('\n').filter((l) => l.trim());
  const metadata: string[] = [];
  const tail: string[] = [];
  const conversation: string[] = [];

  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.type === 'queue-operation' || obj.type === 'summary') {
        metadata.push(line);
      } else if (obj.type === 'last-prompt') {
        tail.push(line);
      } else {
        conversation.push(line);
      }
    } catch {
      conversation.push(line);
    }
  }

  const fixedSize = metadata.reduce((s, l) => s + l.length + 1, 0)
    + tail.reduce((s, l) => s + l.length + 1, 0);
  const budget = targetBytes - fixedSize;

  const kept: string[] = [];
  let usedBytes = 0;
  for (let i = conversation.length - 1; i >= 0; i--) {
    const lineSize = conversation[i].length + 1;
    if (usedBytes + lineSize > budget) break;
    kept.unshift(conversation[i]);
    usedBytes += lineSize;
  }

  if (kept.length === conversation.length) return 0;

  const truncated = [...metadata, ...kept, ...tail].join('\n') + '\n';
  const bytesRemoved = content.length - truncated.length;
  fs.writeFileSync(filePath, truncated);
  return bytesRemoved;
}
