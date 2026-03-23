/**
 * Shared tool call breadcrumb formatting.
 * Converts tool call data into compact S3-linked breadcrumbs.
 *
 * Two input formats supported:
 * 1. \x00TOOLCALL:{json} — structured data from agent-runner (preferred)
 * 2. <details> HTML — legacy format (still handled for backwards compat)
 */
import crypto from 'crypto';
import { uploadHtml, getPresignedUrl } from './s3-sync.js';
import { escapeHtml } from './formatting.js';

const esc = escapeHtml;

/** Check if text is a \x00TOOLCALL: marker from the agent-runner. */
export function isToolCallMarker(text: string): boolean {
  return text.startsWith('\x00TOOLCALL:');
}

/** Check if text is a legacy <details> tool call block. */
export function isToolCallBlock(text: string): boolean {
  return text.trimStart().startsWith('<details>') && text.includes('🔧');
}

/** Check if text contains any <details> block. */
export function hasDetailsBlock(text: string): boolean {
  return text.includes('<details>');
}

/** Parse a \x00TOOLCALL:{json} marker into structured data. */
export function parseToolCallMarker(text: string): { label: string; input: string; output: string } | null {
  if (!isToolCallMarker(text)) return null;
  try {
    return JSON.parse(text.slice(10));
  } catch {
    return null;
  }
}

/** Create an S3 breadcrumb from structured tool call data. */
export async function toolCallBreadcrumbFromData(
  data: { label: string; input: string; output: string },
  botName: string,
  groupName: string,
): Promise<string> {
  const raw = JSON.stringify(data);
  const hash = crypto.createHash('sha1').update(raw).digest('hex').slice(0, 7);
  const title = data.label || 'Tool call';
  const s3Key = `tool-calls/${botName}/${Date.now()}-${hash}.html`;

  const pageHtml = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>🔧 ${esc(botName)} - ${esc(title)}</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0d1117;color:#c9d1d9;font:13px/1.6 ui-monospace,monospace;padding:16px}
h1{font-size:15px;color:#58a6ff;margin-bottom:4px}.meta{color:#6e7681;font-size:11px;margin-bottom:16px;border-bottom:1px solid #21262d;padding-bottom:8px}
.block{background:#161b22;border:1px solid #30363d;border-radius:6px;padding:12px;overflow-x:auto}
pre{background:#0d1117;border:1px solid #21262d;border-radius:4px;padding:10px;overflow-x:auto;font-size:12px}
h2{font-size:13px;color:#e6edf3;margin:8px 0 4px}code{font-family:inherit}</style>
</head><body><h1>🔧 ${esc(botName)}</h1>
<div class="meta">${esc(groupName)} · ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC</div>
<div class="block"><h2>${esc(title)}</h2>
<h2>Input</h2><pre><code>${esc(data.input)}</code></pre>
<h2>Output</h2><pre><code>${esc(data.output)}</code></pre>
</div></body></html>`;

  try {
    await uploadHtml(s3Key, pageHtml);
  } catch {
    throw new Error('S3 upload failed — suppress tool call output');
  }
  const url = await getPresignedUrl(s3Key);
  if (!url) throw new Error('S3 presign failed — suppress tool call output');
  return `<font color="#888888">🔧 <em>${esc(title)}</em> · <a href="${url}"><code>${hash}</code></a></font>`;
}

/** Convert a legacy <details> tool call block into a compact S3-linked breadcrumb. */
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

  try {
    await uploadHtml(s3Key, pageHtml);
  } catch {
    throw new Error('S3 upload failed — suppress tool call output');
  }
  const url = await getPresignedUrl(s3Key);
  if (!url) throw new Error('S3 presign failed — suppress tool call output');
  return `<font color="#888888">🔧 <em>${esc(title)}</em> · <a href="${url}"><code>${hash}</code></a></font>`;
}
