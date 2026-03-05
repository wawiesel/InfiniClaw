/**
 * Skill sync: symlink role-assigned skills from the pool into the session.
 * Skills live in bots/skills/. Each role lists its skills in
 * bots/{role}/skills.json. Session .claude/skills/ contains symlinks so
 * edits persist directly to the source.
 */
import fs from 'fs';
import path from 'path';
import { logger } from 'nanoclaw/logger.js';

const SAFE_SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function isWithinBase(baseDir: string, candidate: string): boolean {
  const rel = path.relative(baseDir, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

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

  let roleSkills: unknown;
  try {
    roleSkills = JSON.parse(fs.readFileSync(skillsFile, 'utf-8'));
  } catch (err) {
    logger.warn({ err, skillsFile }, 'Failed to read skills.json, no skills loaded');
    return;
  }

  if (!Array.isArray(roleSkills)) {
    logger.warn({ skillsFile }, 'skills.json is not an array, no skills loaded');
    return;
  }
  const normalizedRoleSkills = new Set(
    roleSkills
      .filter((s): s is string => typeof s === 'string')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );

  let resolvedSkillsPoolDir: string;
  try {
    resolvedSkillsPoolDir = fs.realpathSync(path.resolve(skillsPoolDir));
  } catch (err) {
    logger.warn({ err, skillsPoolDir }, 'Skills pool directory is not accessible, no skills loaded');
    return;
  }

  for (const skillName of normalizedRoleSkills) {
    if (!SAFE_SKILL_NAME.test(skillName)) {
      logger.warn({ skillName }, 'skill-sync: skipping skill with invalid name');
      continue;
    }

    const srcDir = path.resolve(resolvedSkillsPoolDir, skillName);
    if (!isWithinBase(resolvedSkillsPoolDir, srcDir)) {
      logger.warn({ skillName }, 'skill-sync: skipping skill with path traversal');
      continue;
    }

    let realSrcDir: string;
    try {
      realSrcDir = fs.realpathSync(srcDir);
    } catch {
      logger.warn({ skillName, srcDir }, 'Skill not found in pool, skipping');
      continue;
    }

    if (!isWithinBase(resolvedSkillsPoolDir, realSrcDir)) {
      logger.warn({ skillName, realSrcDir }, 'skill-sync: skipping skill symlink outside pool');
      continue;
    }

    if (!fs.statSync(realSrcDir).isDirectory()) {
      logger.warn({ skillName, realSrcDir }, 'Skill is not a directory in pool, skipping');
      continue;
    }
    const dest = path.join(sessionSkillsDir, skillName);
    try {
      fs.symlinkSync(realSrcDir, dest);
    } catch (err: any) {
      if (err.code === 'EEXIST') {
        fs.rmSync(dest, { recursive: true });
        fs.symlinkSync(realSrcDir, dest);
      } else {
        throw err;
      }
    }
  }
}
