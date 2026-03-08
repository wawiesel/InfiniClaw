import fs from 'fs';
import path from 'path';
import { ASSISTANT_NAME, DATA_DIR } from 'nanoclaw/config.js';
import { getAllRegisteredGroups, getSession } from 'nanoclaw/db.js';

export interface TodoItem { content: string; status: 'pending' | 'in_progress' | 'completed'; activeForm?: string }
const STATUS_ICON: Record<string, string> = { in_progress: '🔧', pending: '⏳', completed: '✅' };

export function readTodoItems(folder: string): TodoItem[] {
  const todosDir = path.join(DATA_DIR, 'sessions', folder, '.claude', 'todos');
  if (!fs.existsSync(todosDir)) return [];
  const sessionId = getSession(folder);
  if (!sessionId) return [];
  const sessionFile = path.join(todosDir, `${sessionId}-agent-${sessionId}.json`);
  if (!fs.existsSync(sessionFile)) return [];
  try {
    const raw = fs.readFileSync(sessionFile, 'utf-8').trim();
    if (!raw || raw === '[]') return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((t: unknown) => t && typeof t === 'object' && 'content' in t && 'status' in t) as TodoItem[];
  } catch { return []; }
}

export function buildTodoMessage(chatJid: string): string {
  const groups = getAllRegisteredGroups();
  const group = groups[chatJid];
  if (!group) return `📋 ${ASSISTANT_NAME}\n\nRoom not registered.`;
  const items = readTodoItems(group.folder);
  const lines: string[] = [`📋 ${ASSISTANT_NAME} — ${group.name}\n`];
  if (items.length === 0) {
    lines.push('No active tasks.');
  } else {
    for (const item of items) lines.push(`${STATUS_ICON[item.status] ?? '·'} ${item.content}`);
  }
  lines.push('');
  const statusPath = path.join(DATA_DIR, 'ipc', group.folder, 'status.json');
  try {
    const snap = JSON.parse(fs.readFileSync(statusPath, 'utf-8'));
    const g = snap.groups?.find((s: { folder: string }) => s.folder === group.folder);
    const objective = g?.lastProgress || g?.currentObjective;
    lines.push(g?.active ? `Currently: ${objective ? objective.slice(0, 200) : 'working'}` : 'Currently: idle');
  } catch { lines.push('Currently: idle'); }
  return lines.join('\n');
}
