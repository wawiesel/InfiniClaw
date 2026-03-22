/**
 * Shared tool call breadcrumb formatting.
 * Used by main.ts (main brain) and relay.ts (branch brains) to convert
 * full <details> tool call blocks into compact S3-linked breadcrumbs.
 */
import crypto from 'crypto';
import { uploadHtml, getPresignedUrl } from './s3-sync.js';
import { escapeHtml } from './formatting.js';

const esc = escapeHtml;

/** Check if text is a tool call (<details> block with 🔧). */
export function isToolCallBlock(text: string): boolean {
  return text.trimStart().startsWith('<details>') && text.includes('🔧');
}

/** Convert a tool call <details> block into a compact S3-linked breadcrumb. */
export async function toolCallBreadcrumb(
  text: string,
  botName: string,
  groupName: string,
): Promise<string> {
  const hash = crypto.createHash('sha1').update(text).digest('hex').slice(0, 7);
  const titleMatch = text.match(/🔧\s*([^<]{1,60})/);
  const title = titleMatch ? titleMatch[1].trim() : 'Tool call';
  const s3Key = `tool-calls/${botName}/${Date.now()}-${hash}.html`;

  const pageHtml = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>🔧 ${esc(botName)} - ${esc(title)}</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0d1117;color:#c9d1d9;font:13px/1.6 ui-monospace,monospace;padding:16px}
h1{font-size:15px;color:#58a6ff;margin-bottom:4px}.meta{color:#6e7681;font-size:11px;margin-bottom:16px;border-bottom:1px solid #21262d;padding-bottom:8px}
.block{background:#161b22;border:1px solid #30363d;border-radius:6px;padding:12px;overflow-x:auto}
pre{background:#0d1117;border:1px solid #21262d;border-radius:4px;padding:10px;overflow-x:auto;font-size:12px}
details summary{cursor:pointer;color:#e6edf3;font-weight:600;padding:4px 0}code{font-family:inherit}</style>
</head><body><h1>🔧 ${esc(botName)}</h1>
<div class="meta">${esc(groupName)} · ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC</div>
<div class="block">${text}</div></body></html>`;

  void uploadHtml(s3Key, pageHtml).catch(() => {});
  const url = await getPresignedUrl(s3Key);
  const hashEl = url ? `<a href="${url}"><code>${hash}</code></a>` : `<code>${hash}</code>`;
  return `<font color="#888888">🔧 <em>${esc(title)}</em> · ${hashEl}</font>`;
}
