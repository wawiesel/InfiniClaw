/**
 * InfiniClaw bot directory and cross-bot messaging.
 */
import fs from 'fs';
import path from 'path';

export function loadBotDirectory(ipcDir: string): Record<string, string> {
  const filePath = path.join(ipcDir, 'bot_directory.json');
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
  } catch { /* best effort */ }
  return {};
}

export function resolveRecipientJid(recipient: string, ipcDir: string): string | null {
  const dir = loadBotDirectory(ipcDir);
  if (dir[recipient]) return dir[recipient];
  const lower = recipient.toLowerCase();
  for (const [name, jid] of Object.entries(dir)) {
    if (name.toLowerCase() === lower) return jid;
  }
  return null;
}

export function guessMimeTypeFromFilename(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  const mimeMap: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.csv': 'text/csv',
    '.json': 'application/json',
    '.zip': 'application/zip',
    '.tar': 'application/x-tar',
    '.gz': 'application/gzip',
  };
  return mimeMap[ext] || 'application/octet-stream';
}
