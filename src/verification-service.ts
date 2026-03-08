import fs from 'fs';
import path from 'path';
import { instanceDir, getActiveBots } from './service.js';

export interface VerificationRecord {
  id: string;
  task_description: string;
  criteria: string;
  requested_by: string;
  assigned_to: string;
  status: 'pending' | 'verified' | 'failed';
  evidence?: string;
  requested_at: string;
  resolved_at?: string;
  source_group: string;
}

function verificationsPath(root: string): string {
  return path.join(root, '_runtime', 'data', 'verifications.json');
}

export function readVerifications(root: string): VerificationRecord[] {
  const filePath = verificationsPath(root);
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return [];
  }
}

export function writeVerifications(root: string, records: VerificationRecord[]): void {
  const filePath = verificationsPath(root);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(records, null, 2));
}

export function syncVerificationsToInstance(root: string, bot: string): void {
  const src = verificationsPath(root);
  if (!fs.existsSync(src)) return;
  const dst = path.join(instanceDir(root, bot), 'data', 'verifications.json');
  try {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  } catch { }
}

export function syncVerificationsToAll(root: string): void {
  for (const bot of getActiveBots()) {
    syncVerificationsToInstance(root, bot);
  }
}
