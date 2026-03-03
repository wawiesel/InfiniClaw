/**
 * Skill sync: symlink role-assigned skills from the pool into the session.
 * Skills live in bots/skills/. Roles assign which skills each role gets
 * via bots/roles.json. Session .claude/skills/ contains symlinks so
 * edits persist directly to the source.
 */
import fs from 'fs';
import path from 'path';
import { logger } from 'nanoclaw/logger.js';

/** Load role-assigned skills as symlinks into the session skills dir. */
export function loadSkillsToSession(
  sessionSkillsDir: string,
  skillsPoolDir: string,
  rolesFile: string,
  role: string,
): void {
  if (fs.existsSync(sessionSkillsDir)) {
    fs.rmSync(sessionSkillsDir, { recursive: true });
  }
  fs.mkdirSync(sessionSkillsDir, { recursive: true });

  let roleSkills: string[] = [];
  try {
    const roles = JSON.parse(fs.readFileSync(rolesFile, 'utf-8'));
    roleSkills = roles[role.toLowerCase()] || [];
  } catch (err) {
    logger.warn({ err, rolesFile, role }, 'Failed to read roles.json, no skills loaded');
    return;
  }

  for (const skillName of roleSkills) {
    const srcDir = path.join(skillsPoolDir, skillName);
    if (!fs.existsSync(srcDir) || !fs.statSync(srcDir).isDirectory()) {
      logger.warn({ skillName, srcDir }, 'Skill not found in pool, skipping');
      continue;
    }
    fs.symlinkSync(srcDir, path.join(sessionSkillsDir, skillName));
  }
}
