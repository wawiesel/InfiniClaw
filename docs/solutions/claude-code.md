# Claude Code Solutions

## Permission prompts on all operators despite shared settings

**Problem:** Operators get unexpected permission prompts even though a shared `settings.json` is in place.

**Cause:** A local `settings.local.json` on one or more machines is overriding the shared file. `settings.local.json` always takes precedence over `settings.json`. The local file may have been created during earlier manual setup and isn't tracked in git.

**Fix:**
```bash
# Check for local override
cat ~/.claude/settings.local.json

# Remove it if it's causing problems
rm ~/.claude/settings.local.json
```

**Notes:**
- Bash permission syntax uses spaces not colons: `Bash(git *)` not `Bash(git:*)`
- Shared operator permissions belong in `.claude/settings.json` tracked in the secrets repo
- `settings.local.json` is machine-specific and intentionally untracked — only use it for per-machine exceptions

---

## Element Desktop: "Render LaTeX maths in messages" lab not appearing

**Problem:** Element Desktop shows Labs settings but the LaTeX rendering toggle is absent.

**Cause:** The webapp bundle (`webapp.asar`) has its own default config that may not include `feature_latex_maths`. The app also needs `show_labs_settings: true` to expose Labs at all.

**Fix:** Create a config override at `~/Library/Application Support/Element/config.json` (macOS):
```json
{
  "show_labs_settings": true,
  "features": {
    "feature_latex_maths": true
  }
}
```
Restart Element. LaTeX rendering will appear in Labs and can be toggled on.

**Notes:**
- Key is `show_labs_settings` (snake_case), not `showLabsSettings`
- Setting `feature_latex_maths: true` in `features` enables it directly without needing the Labs toggle
- Linux path: `~/.config/Element/config.json`
