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
export function loadSkillsToSession(sessionSkillsDir, skillsPoolDir, skillsFile) {
    if (fs.existsSync(sessionSkillsDir)) {
        fs.rmSync(sessionSkillsDir, { recursive: true });
    }
    fs.mkdirSync(sessionSkillsDir, { recursive: true });
    let roleSkills;
    try {
        roleSkills = JSON.parse(fs.readFileSync(skillsFile, 'utf-8'));
    }
    catch (err) {
        logger.warn({ err, skillsFile }, 'Failed to read skills.json, no skills loaded');
        return;
    }
    if (!Array.isArray(roleSkills)) {
        logger.warn({ skillsFile }, 'skills.json is not an array, no skills loaded');
        return;
    }
    const normalizedRoleSkills = roleSkills.filter((s) => typeof s === 'string');
    const resolvedSkillsPoolDir = path.resolve(skillsPoolDir);
    for (const skillName of normalizedRoleSkills) {
        const srcDir = path.resolve(skillsPoolDir, skillName);
        if (!srcDir.startsWith(resolvedSkillsPoolDir + path.sep)) {
            logger.warn({ skillName }, 'skill-sync: skipping skill with path traversal');
            continue;
        }
        if (!fs.existsSync(srcDir) || !fs.statSync(srcDir).isDirectory()) {
            logger.warn({ skillName, srcDir }, 'Skill not found in pool, skipping');
            continue;
        }
        const dest = path.join(sessionSkillsDir, skillName);
        try {
            fs.symlinkSync(srcDir, dest);
        }
        catch (err) {
            if (err.code === 'EEXIST') {
                fs.rmSync(dest, { recursive: true });
                fs.symlinkSync(srcDir, dest);
            }
            else {
                throw err;
            }
        }
    }
}
//# sourceMappingURL=skill-sync.js.map