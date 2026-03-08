# bots/skills/

Shared skill pool. Each skill is a directory containing a `SKILL.md` that defines the skill's behavior. Skills are assigned to roles via `bots/{role}/skills.json`.

Skills are synced into container sessions at bot startup by `src/skill-sync.ts`.
