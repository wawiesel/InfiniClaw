/**
 * Skill sync: one-way load from persona + shared → session.
 * Bots write skills directly to the persona dir (mounted writable).
 * Session is rebuilt from persona + shared on every container spawn.
 */
import fs from 'fs';
import path from 'path';

/** Clean session skills and rebuild from shared + persona sources of truth. */
export function loadSkillsToSession(
  sessionSkillsDir: string,
  personaSkillsDir: string,
  sharedSkillsDir: string,
): void {
  if (fs.existsSync(sessionSkillsDir)) {
    fs.rmSync(sessionSkillsDir, { recursive: true });
  }
  fs.mkdirSync(sessionSkillsDir, { recursive: true });

  const syncFrom = (src: string) => {
    if (!fs.existsSync(src)) return;
    for (const entry of fs.readdirSync(src)) {
      const srcDir = path.join(src, entry);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      fs.cpSync(srcDir, path.join(sessionSkillsDir, entry), { recursive: true });
    }
  };

  // Shared first, then persona (persona overrides shared if same name)
  syncFrom(sharedSkillsDir);
  syncFrom(personaSkillsDir);
}
