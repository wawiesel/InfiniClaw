/**
 * Skill sync: bidirectional sync between session .claude/skills/ and persona skills dir.
 * Session is authoritative — REPLACE semantics (respects bot deletions).
 * Shared skills are excluded from save-back so repo updates aren't masked.
 *
 * Also callable as CLI: node dist/skill-sync.js save-back <session> <persona> <shared>
 */
import fs from 'fs';
import path from 'path';

function copyDirRecursive(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, dstPath);
    } else {
      fs.copyFileSync(srcPath, dstPath);
    }
  }
}

function getSharedSkillNames(sharedSkillsDir: string): Set<string> {
  const names = new Set<string>();
  if (!fs.existsSync(sharedSkillsDir)) return names;
  for (const name of fs.readdirSync(sharedSkillsDir)) {
    if (fs.statSync(path.join(sharedSkillsDir, name)).isDirectory()) {
      names.add(name);
    }
  }
  return names;
}

/** Replace persona skills with session skills (authoritative — respects deletions).
 *  Excludes shared skills so repo updates aren't masked by stale persona copies. */
export function saveSkillsToPersona(
  sessionSkillsDir: string,
  personaSkillsDir: string,
  sharedSkillsDir: string,
): void {
  if (!fs.existsSync(sessionSkillsDir)) return;

  const sharedNames = getSharedSkillNames(sharedSkillsDir);

  // Clean persona skills (preserve .gitkeep)
  if (fs.existsSync(personaSkillsDir)) {
    for (const entry of fs.readdirSync(personaSkillsDir)) {
      if (entry === '.gitkeep') continue;
      fs.rmSync(path.join(personaSkillsDir, entry), { recursive: true });
    }
  } else {
    fs.mkdirSync(personaSkillsDir, { recursive: true });
  }

  // Copy session skills → persona (skip shared)
  for (const skill of fs.readdirSync(sessionSkillsDir)) {
    const srcDir = path.join(sessionSkillsDir, skill);
    if (!fs.statSync(srcDir).isDirectory()) continue;
    if (sharedNames.has(skill)) continue;
    copyDirRecursive(srcDir, path.join(personaSkillsDir, skill));
  }
}

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
      copyDirRecursive(srcDir, path.join(sessionSkillsDir, entry));
    }
  };

  // Shared first, then persona (persona overrides shared if same name)
  syncFrom(sharedSkillsDir);
  syncFrom(personaSkillsDir);
}

// CLI entry point for bash callers
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname === new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  const [cmd, sessionDir, personaDir, sharedDir] = process.argv.slice(2);
  if (cmd === 'save-back' && sessionDir && personaDir && sharedDir) {
    saveSkillsToPersona(sessionDir, personaDir, sharedDir);
  } else {
    console.error('Usage: skill-sync.js save-back <sessionSkillsDir> <personaSkillsDir> <sharedSkillsDir>');
    process.exit(1);
  }
}
