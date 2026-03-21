/**
 * InfiniClaw model selection and validation for the agent runner.
 * Ollama detection, model family matching, main model enforcement.
 */

export const MAIN_MODEL_ENV_KEY = 'ANTHROPIC_MODEL';

export const MAIN_DELEGATE_POLICY = `Main brain / lobe policy:
- You are one brain identity operating multiple lobes.
- Delegation means lobe cloning, not autonomous handoff.
- Each lobe gets a tightly-scoped objective with acceptance criteria and reports back for integration.
- MAIN brain stays user-responsive while lobes execute.
- For multi-step or long-running execution, launch lobes via mcp__infiniclaw__delegate_to_lobe (supports codex, gemini, claude, ollama).
- For quick local LLM queries (formatting, classification), use mcp__infiniclaw__query_local_llm.
- Lobe outputs are intermediate cognition. Collapse and integrate results back into one coherent MAIN response.
- Own final quality: verify lobe outputs, correct drift, and take responsibility for final results.
- If user asks "what are you doing" during active work, provide concrete state (completed, running, next) immediately.
- Your final response text is delivered to the user automatically by the host.`;

function firstSet(...values: Array<string | undefined>): string | undefined {
  for (const v of values) {
    const s = v?.trim();
    if (s) return s;
  }
  return undefined;
}

export function getRequestedMainModel(env: Record<string, string | undefined>): string | undefined {
  return firstSet(env[MAIN_MODEL_ENV_KEY]);
}

export function claudeModelFamily(model: string): 'opus' | 'sonnet' | 'haiku' | 'unknown' {
  const normalized = model.trim().toLowerCase();
  if (normalized.includes('opus')) return 'opus';
  if (normalized.includes('sonnet')) return 'sonnet';
  if (normalized.includes('haiku')) return 'haiku';
  return 'unknown';
}

export function modelMatchesRequest(requested: string, actual: string): boolean {
  const req = requested.trim().toLowerCase();
  const act = actual.trim().toLowerCase();
  if (!req || !act) return false;
  if (req === act) return true;

  // Allow family aliases (opus/sonnet/haiku) to match concrete dated models.
  const reqFamily = claudeModelFamily(req);
  const actFamily = claudeModelFamily(act);
  if (reqFamily !== 'unknown' && actFamily !== 'unknown' && reqFamily === actFamily) {
    return true;
  }

  return false;
}

export function isOllamaAnthropicBaseUrl(baseUrl: string | undefined): boolean {
  const trimmed = baseUrl?.trim();
  if (!trimmed) return false;

  const normalized = trimmed.toLowerCase();
  if (normalized.includes('ollama')) return true;

  try {
    const parsed = new URL(trimmed);
    const port =
      parsed.port ||
      (parsed.protocol === 'https:' ? '443' : parsed.protocol === 'http:' ? '80' : '');
    return port === '11434';
  } catch {
    return false;
  }
}
