/**
 * 22-signals.md — Signals Protocol
 *
 * Signals are inline `{{command args}}` directives in bot output.
 * The relay extracts, processes, and strips them before posting to Matrix.
 */

import { uploadHtml, getPresignedUrl } from './s3-sync.js';
import { logger } from 'nanoclaw/logger.js';

// ── Types ──────────────────────────────────────────────────────────────

export interface Signal {
  raw: string;           // Original {{...}} text
  command: string;       // e.g. "m", "send"
  args: Record<string, string>; // e.g. { room: "engineering", thread: "$abc" }
  positional?: string;   // For {{m Name}} — the positional arg
}

export interface ProcessedSignal extends Signal {
  status: 'ok' | 'error';
  error?: string;        // Why it failed
  s3Url?: string;        // Presigned URL to the S3 audit record
}

export interface SignalResult {
  cleanText: string;         // Message with signals stripped
  signals: ProcessedSignal[];
  auditSuffix: string;       // e.g. "{{1 2}}" with links
  routeOverride?: {
    room?: string;
    thread?: string;
  };
  callouts: string[];        // Bot names from {{m Name}} signals
}

export interface BranchRequest {
  title: string;
  objective: string;
}

export interface MergeRequest {
  summary?: string;
}

// ── Signal extraction ──────────────────────────────────────────────────

const SIGNAL_RE = /\{\{([^}]+)\}\}/g;
/** Matches backtick-wrapped code spans that may contain {{ }} — these are escaped. */
const CODE_SPAN_RE = /`[^`]*\{\{[^`]*`/g;

/** Parse a single signal string like `m Tali` or `send room="engineering" thread="$abc"` */
function parseSignal(raw: string, inner: string): Signal {
  const parts = inner.trim().split(/\s+/);
  const command = parts[0].toLowerCase();

  const args: Record<string, string> = {};
  let positional: string | undefined;

  for (let i = 1; i < parts.length; i++) {
    const eq = parts[i].indexOf('=');
    if (eq > 0) {
      const key = parts[i].slice(0, eq);
      // Handle quoted values: key="value" possibly spanning to next parts
      let value = parts[i].slice(eq + 1);
      if (value.startsWith('"')) {
        value = value.slice(1);
        while (!value.endsWith('"') && i + 1 < parts.length) {
          i++;
          value += ' ' + parts[i];
        }
        if (value.endsWith('"')) value = value.slice(0, -1);
      }
      args[key] = value;
    } else {
      // Positional arg (e.g. {{m Tali}})
      positional = (positional ? positional + ' ' : '') + parts[i];
    }
  }

  return { raw: `{{${inner}}}`, command, args, positional };
}

/** Extract all signals from text, return parsed signals and cleaned text.
 *  Signals inside backtick code spans are escaped and left untouched. */
export function extractSignals(text: string): { signals: Signal[]; cleanText: string } {
  // Fast path: most messages contain no signals at all
  if (!text.includes('{{')) return { signals: [], cleanText: text };

  // Protect backtick-escaped signals by replacing them with placeholders
  const escaped: string[] = [];
  const safeText = text.replace(CODE_SPAN_RE, (match) => {
    escaped.push(match);
    return `\x00ESC${escaped.length - 1}\x00`;
  });

  const signals: Signal[] = [];
  let cleanText = safeText.replace(SIGNAL_RE, (match, inner) => {
    signals.push(parseSignal(match, inner));
    return '';
  }).trim();

  // Restore escaped code spans
  cleanText = cleanText.replace(/\x00ESC(\d+)\x00/g, (_, idx) => escaped[Number(idx)]);

  return { signals, cleanText };
}

// ── Signal processing ──────────────────────────────────────────────────

interface SignalContext {
  botName: string;
  roomName: string;
  roomId: string;
  threadId?: string;
  /** Map of room names to room IDs */
  roomLookup: (name: string) => string | undefined;
}

/** Process extracted signals and determine routing + callouts */
export function processSignals(signals: Signal[], ctx: SignalContext): {
  processed: ProcessedSignal[];
  routeOverride?: { room?: string; thread?: string };
  callouts: string[];
  branchRequest?: BranchRequest;
  mergeRequest?: MergeRequest;
} {
  const processed: ProcessedSignal[] = [];
  let routeOverride: { room?: string; thread?: string } | undefined;
  const callouts: string[] = [];
  let branchRequest: BranchRequest | undefined;
  let mergeRequest: MergeRequest | undefined;

  for (const sig of signals) {
    switch (sig.command) {
      case 'm': {
        // Callout: {{m BotName}}
        const name = sig.positional?.trim();
        if (!name) {
          processed.push({ ...sig, status: 'error', error: 'Missing bot name' });
        } else {
          callouts.push(name);
          processed.push({ ...sig, status: 'ok' });
        }
        break;
      }
      case 'send': {
        // Route: {{send room="engineering" thread="$eventId"}}
        const room = sig.args.room;
        const thread = sig.args.thread;
        if (!room && !thread) {
          processed.push({ ...sig, status: 'error', error: 'send requires room and/or thread' });
        } else {
          if (room) {
            const resolvedRoom = ctx.roomLookup(room);
            if (!resolvedRoom) {
              processed.push({ ...sig, status: 'error', error: `Unknown room: ${room}` });
              break;
            }
            routeOverride = { ...routeOverride, room: resolvedRoom };
          }
          if (thread) {
            routeOverride = { ...routeOverride, thread };
          }
          processed.push({ ...sig, status: 'ok' });
        }
        break;
      }
      case 'branch': {
        // Branch: {{branch title="X" objective="Y"}}
        const title = sig.args.title || sig.positional;
        const objective = sig.args.objective;
        if (!title || !objective) {
          processed.push({ ...sig, status: 'error', error: 'branch requires title and objective' });
        } else {
          branchRequest = { title, objective };
          processed.push({ ...sig, status: 'ok' });
        }
        break;
      }
      case 'merge': {
        // Merge: {{merge summary="result"}}
        mergeRequest = { summary: sig.args.summary || sig.positional };
        processed.push({ ...sig, status: 'ok' });
        break;
      }
      default:
        processed.push({ ...sig, status: 'error', error: `Unknown signal command: ${sig.command}` });
    }
  }

  return { processed, routeOverride, callouts, branchRequest, mergeRequest };
}

// ── Audit trail ────────────────────────────────────────────────────────

/** Upload signal audit records to S3 and generate the {{1 2}} suffix */
export async function auditSignals(
  processed: ProcessedSignal[],
  botName: string,
  roomName: string,
): Promise<{ suffix: string; processed: ProcessedSignal[] }> {
  if (processed.length === 0) return { suffix: '', processed };

  const timestamp = new Date().toISOString();
  const indices: string[] = [];

  for (let i = 0; i < processed.length; i++) {
    const sig = processed[i];
    const idx = i + 1;
    const s3Key = `infiniclaw/signals/${botName}/${Date.now()}-${idx}.html`;

    const html = `<!DOCTYPE html><html><head><title>Signal ${idx}</title></head><body>
<h3>Signal #${idx}</h3>
<table>
<tr><td><b>Bot</b></td><td>${botName}</td></tr>
<tr><td><b>Room</b></td><td>${roomName}</td></tr>
<tr><td><b>Time</b></td><td>${timestamp}</td></tr>
<tr><td><b>Signal</b></td><td><code>${sig.raw}</code></td></tr>
<tr><td><b>Command</b></td><td>${sig.command}</td></tr>
<tr><td><b>Status</b></td><td>${sig.status}</td></tr>
${sig.error ? `<tr><td><b>Error</b></td><td>${sig.error}</td></tr>` : ''}
</table></body></html>`;

    try {
      await uploadHtml(s3Key, html);
      const url = await getPresignedUrl(s3Key);
      sig.s3Url = url ?? undefined;
      indices.push(url ? `[${idx}](${url})` : `${idx}`);
    } catch (err) {
      logger.warn({ err, s3Key }, 'Failed to upload signal audit');
      indices.push(`${idx}`);
    }
  }

  const suffix = `{{${indices.join(' ')}}}`;
  return { suffix, processed };
}

// ── Error notification ─────────────────────────────────────────────────

/** Generate loudspeaker error message for failed signals */
export function formatSignalError(sig: ProcessedSignal, botName: string, fallbackLocation: string): string {
  const time = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const s3Link = sig.s3Url ? ` [details](${sig.s3Url})` : '';
  return `⚠️ Signal failed for ${botName} at ${time} — \`${sig.raw}\` — ${sig.error}. Message delivered to ${fallbackLocation}.${s3Link}`;
}
