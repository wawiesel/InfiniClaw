/**
 * InfiniClaw container secret normalization.
 * Ollama-mode provider normalization and cert path mapping.
 */
import fs from 'fs';
import path from 'path';

import { isOllamaBaseUrl } from '../env-utils.js';

const CERT_PATH_ENV_VARS = [
  'SSL_CERT_FILE',
  'NODE_EXTRA_CA_CERTS',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
  'GIT_SSL_CAINFO',
] as const;

interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

/**
 * Normalize secrets for Ollama mode.
 * When the Anthropic base URL points to Ollama, strip OAuth tokens
 * and force all SDK model slots to the configured model.
 */
export function normalizeProviderSecrets(
  secrets: Record<string, string>,
): Record<string, string> {
  const normalized = { ...secrets };
  if (!isOllamaBaseUrl(normalized.ANTHROPIC_BASE_URL)) {
    return normalized;
  }

  // In Ollama mode, force Claude SDK to use Anthropic-compatible endpoint auth.
  // Passing account OAuth here can cause SDK to ignore base URL routing.
  delete normalized.CLAUDE_CODE_OAUTH_TOKEN;
  delete normalized.ANTHROPIC_API_KEY;

  const explicitModel = normalized.ANTHROPIC_MODEL?.trim();
  if (explicitModel) {
    normalized.ANTHROPIC_MODEL = explicitModel;
    // Force all SDK model slots to the same ollama model so haiku/sonnet
    // fallbacks never try models ollama doesn't have.
    normalized.ANTHROPIC_SMALL_FAST_MODEL = explicitModel;
    normalized.ANTHROPIC_DEFAULT_SONNET_MODEL = explicitModel;
  }

  if (!normalized.ANTHROPIC_AUTH_TOKEN?.trim()) {
    normalized.ANTHROPIC_AUTH_TOKEN = 'ollama';
  }

  // SDK runtime knobs for local models:
  // - Skip token counting API (ollama has no /v1/messages/count_tokens)
  // - Cap context window to match local model limits
  // - Reduce max output tokens so input context has room (32K - 4K = 28K input)
  normalized.NANOCLAW_SKIP_TOKEN_COUNTING = '1';
  normalized.NANOCLAW_CONTEXT_WINDOW = '32000';
  normalized.CLAUDE_CODE_MAX_OUTPUT_TOKENS = '4096';

  return normalized;
}

/**
 * Map host cert file paths to container paths via volume mounts.
 * Normalizes CA bundle env so Node, Python/requests, curl, and git
 * all see the same trust anchor.
 */
export function mapCertPathSecretsToContainer(
  secrets: Record<string, string>,
  mounts: VolumeMount[],
): Record<string, string> {
  const mapped = { ...secrets };
  const certMountRoot = '/workspace/host-certs';

  for (const key of CERT_PATH_ENV_VARS) {
    const value = mapped[key];
    if (!value) continue;
    if (!path.isAbsolute(value) || !fs.existsSync(value)) continue;

    const safeName = path.basename(value).replace(/[^a-zA-Z0-9._-]/g, '_');
    const containerPath = `${certMountRoot}/${key.toLowerCase()}-${safeName}`;

    if (
      !mounts.some(
        (m) => m.hostPath === value && m.containerPath === containerPath,
      )
    ) {
      mounts.push({
        hostPath: value,
        containerPath,
        readonly: true,
      });
    }

    mapped[key] = containerPath;
  }

  // Normalize CA bundle env so Node, Python/requests, curl, and git all see
  // the same trust anchor even if only one variable is provided by the host.
  const certBundle =
    mapped.SSL_CERT_FILE ||
    mapped.NODE_EXTRA_CA_CERTS ||
    mapped.REQUESTS_CA_BUNDLE ||
    mapped.CURL_CA_BUNDLE ||
    mapped.GIT_SSL_CAINFO;
  if (certBundle) {
    if (!mapped.SSL_CERT_FILE) mapped.SSL_CERT_FILE = certBundle;
    if (!mapped.NODE_EXTRA_CA_CERTS) mapped.NODE_EXTRA_CA_CERTS = certBundle;
    if (!mapped.REQUESTS_CA_BUNDLE) mapped.REQUESTS_CA_BUNDLE = certBundle;
    if (!mapped.CURL_CA_BUNDLE) mapped.CURL_CA_BUNDLE = certBundle;
    if (!mapped.GIT_SSL_CAINFO) mapped.GIT_SSL_CAINFO = certBundle;
  }

  return mapped;
}
