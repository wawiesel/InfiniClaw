/**
 * Skill sync: symlink role-assigned skills from the pool into the session.
 * Skills live in bots/skills/. Each role lists its skills in
 * bots/{role}/skills.json. Session .claude/skills/ contains symlinks so
 * edits persist directly to the source.
 */
import fs from 'fs';
import path from 'path';
import { logger } from 'nanoclaw/logger.js';

/** Load role-assigned skills as symlinks into the session skills dir. */
export function loadSkillsToSession(
  sessionSkillsDir: string,
  skillsPoolDir: string,
  skillsFile: string,
): void {
  if (fs.existsSync(sessionSkillsDir)) {
    fs.rmSync(sessionSkillsDir, { recursive: true });
  }
  fs.mkdirSync(sessionSkillsDir, { recursive: true });

  let roleSkills: string[] = [];
  try {
    roleSkills = JSON.parse(fs.readFileSync(skillsFile, 'utf-8'));
  } catch (err) {
    logger.warn({ err, skillsFile }, 'Failed to read skills.json, no skills loaded');
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
