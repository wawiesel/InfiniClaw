---
name: update-lobes
description: Check for and apply updates to delegate lobe default models (Codex, Gemini, Claude). Run periodically or when the Captain reports a lobe is outdated.
---

# Update Lobes

Keep the delegate lobe default models current. When new model versions are released, update the defaults in `delegate-runner.ts` so all bots use the latest.

## When to run

- When the Captain says a lobe model is outdated
- Periodically (weekly) as part of health checks
- After seeing delegation errors that suggest a model name has been deprecated

## Source file

The default models are defined in:
```
$INFINICLAW_ROOT/external/nanoclaw/container/agent-runner/src/delegate-runner.ts
```

Two locations need updating:

### 1. Tool description (around line 269)
```typescript
Available lobes and models:
- codex (default): gpt-5.3-codex (default), ...
- gemini: gemini-3.1-pro-preview (default), ...
- claude: sonnet (default), opus, haiku ...
- ollama: ...
```

### 2. effectiveModel resolver (around line 318)
```typescript
const effectiveModel = (() => {
  if (args.model) return args.model;
  if (lobe === 'gemini') return firstSet(process.env.GEMINI_MODEL) || 'gemini-3.1-pro-preview';
  if (lobe === 'claude') return firstSet(process.env.ANTHROPIC_MODEL, process.env.CLAUDE_MODEL) || 'sonnet';
  if (lobe === 'ollama') return 'qwen3:14b';
  return firstSet(process.env.CODEX_MODEL, process.env.OPENAI_MODEL) || 'gpt-5.3-codex';
})();
```

## Steps

1. **Research current models** — Use web search to find the latest model identifiers:
   - OpenAI Codex: search "OpenAI Codex latest model 2026"
   - Google Gemini: search "Google Gemini latest model API identifier 2026"
   - Anthropic Claude: search "Anthropic Claude latest model 2026"

2. **Compare with current defaults** — Read `delegate-runner.ts` and compare the hardcoded defaults against what's current.

3. **If updates needed:**
   - Edit both the tool description and the `effectiveModel` resolver in `delegate-runner.ts`
   - Build: `cd $INFINICLAW_ROOT && npm run build`
   - Commit with a descriptive message
   - Report changes to Engineering

4. **If no updates needed** — Report that lobes are current.

## Model selection rules

Per Captain's standing orders:
- **Codex/Gemini**: Always use the max-capability model (not mini/flash variants)
- **Claude**: Use `sonnet` or `opus` (not haiku unless specifically requested)
- **Ollama**: Last resort fallback only — don't upgrade proactively

## NPX packages

The lobes are invoked via npx (no version pinning — gets latest):
- Codex: `npx -y @openai/codex`
- Gemini: `npx -y @google/gemini-cli`
- Claude: uses `claude` CLI directly (not npx)

No package version changes needed — only the `--model` argument defaults matter.
