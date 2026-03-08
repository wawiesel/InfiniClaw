import fs from 'fs';
import path from 'path';
import { instanceDir, personaDir } from './service.js';

/**
 * Sync persona state before redeploy.
 * Persona CLAUDE.md is edited directly by bots via writable mount — no copy needed.
 * Group CLAUDE.md is ONE-WAY (repo → instance) — no save-back.
 * MCP servers are ONE-WAY (persona → session) — no save-back.
 */
export function syncPersona(root: string, bot: string): void {
  const instance = instanceDir(root, bot);
  const persona = personaDir(root, bot);
  if (!fs.existsSync(persona)) return;

  // Guard: only sync if instance data belongs to a recent run
  const runIdPath = path.join(instance, 'data', 'run-id');
  if (!fs.existsSync(runIdPath)) {
    console.log(`${bot}: skipping syncPersona (no run-id, instance data may be stale)`);
    return;
  }
  try {
    const ageMs = Date.now() - fs.statSync(runIdPath).mtimeMs;
    if (ageMs > 24 * 60 * 60 * 1000) {
      console.log(`${bot}: skipping syncPersona (run-id is ${Math.round(ageMs / 3600000)}h old)`);
      return;
    }
  } catch { return; }

  // TODO: Implement any required pre-deploy persona sync work here.
  // Current architecture is one-way (repo/persona -> instance), so this is intentionally a no-op.
}

export function restorePersona(root: string, bot: string): void {
  const instance = instanceDir(root, bot);
  const persona = personaDir(root, bot);
  if (!fs.existsSync(persona)) return;

  // Append persona CLAUDE.md to base CLAUDE.md
  const personaClaude = path.join(persona, 'CLAUDE.md');
  if (fs.existsSync(personaClaude)) {
    const content = fs.readFileSync(personaClaude, 'utf-8');
    fs.appendFileSync(path.join(instance, 'CLAUDE.md'), '\n' + content);
  }
}
