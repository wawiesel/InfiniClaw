import fs from 'fs';
import path from 'path';

import {
  MatrixClient,
  MatrixAuth,
  LogService,
  LogLevel,
  SimpleFsStorageProvider,
} from 'matrix-bot-sdk';
import { marked } from 'marked';

import { DATA_DIR, STORE_DIR } from 'nanoclaw/config.js';
import {
  CAPTAIN_USER_ID,
  OPERATOR_USER_ID,
  MATRIX_ACCESS_TOKEN,
  MATRIX_DEVICE_NAME,
  MATRIX_HOMESERVER,
  MATRIX_PASSWORD,
  MATRIX_USER_ID,
  MATRIX_USERNAME,
} from '../infini-config.js';
import { logger } from 'nanoclaw/logger.js';
import {
  Channel,
  NewMessage,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from 'nanoclaw/types.js';
import { escapeHtml } from '../formatting.js';
import { escapeRegex } from '../utils.js';

export interface MatrixChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  /** Display name to set on connect (e.g. "Nora ⭐" for commanding officer). */
  displayName?: string;
}

interface MatrixLoginResponse {
  access_token?: string;
  refresh_token?: string;
  user_id?: string;
  device_id?: string;
  expires_in_ms?: number;
}

const MEDIA_MSGTYPES = ['m.image', 'm.file', 'm.video', 'm.audio'];
const MEDIA_MAX_BYTES = 50 * 1024 * 1024; // 50 MB

const STORAGE_ACCESS_TOKEN = 'matrix_access_token';
const STORAGE_REFRESH_TOKEN = 'matrix_refresh_token';
const STORAGE_DEVICE_ID = 'matrix_device_id';
const STORAGE_USER_ID = 'matrix_user_id';
const MATRIX_SEND_TIMEOUT_MS = 10_000;
const MATRIX_UPLOAD_TIMEOUT_MS = 120_000;
const MATRIX_TYPING_TIMEOUT_MS = 3_000;
const MATRIX_META_TIMEOUT_MS = 5_000;
const MATRIX_HEALTH_TIMEOUT_MS = 10_000;
const MATRIX_CONNECT_TIMEOUT_MS = 60_000;
let matrixSdkLoggerConfigured = false;

function isExpectedAccountDataMissing(args: unknown[]): boolean {
  return args.some((arg) => {
    if (!arg || typeof arg !== 'object') return false;
    const record = arg as Record<string, unknown>;
    const errcode =
      typeof record.errcode === 'string'
        ? record.errcode
        : typeof (record.body as Record<string, unknown> | undefined)?.errcode ===
            'string'
          ? ((record.body as Record<string, unknown>).errcode as string)
          : undefined;
    const message =
      typeof record.error === 'string'
        ? record.error
        : typeof (record.body as Record<string, unknown> | undefined)?.error ===
            'string'
          ? ((record.body as Record<string, unknown>).error as string)
          : '';
    return errcode === 'M_NOT_FOUND' && message === 'Account data not found';
  });
}

function configureMatrixSdkLogger(): void {
  if (matrixSdkLoggerConfigured) return;
  matrixSdkLoggerConfigured = true;
  LogService.setLevel(LogLevel.INFO);
  LogService.setLogger({
    info: (module, ...args) => logger.debug({ module, args }, 'matrix-sdk info'),
    debug: (module, ...args) => logger.trace({ module, args }, 'matrix-sdk debug'),
    trace: (module, ...args) => logger.trace({ module, args }, 'matrix-sdk trace'),
    warn: (module, ...args) => {
      if (isExpectedAccountDataMissing(args)) {
        logger.debug('Matrix account-data not found (expected on fresh sessions)');
        return;
      }
      logger.warn({ module, args }, 'matrix-sdk warn');
    },
    error: (module, ...args) => {
      if (isExpectedAccountDataMissing(args)) {
        logger.debug('Matrix account-data not found (expected on fresh sessions)');
        return;
      }
      logger.warn({ module, args }, 'matrix-sdk error');
    },
  });
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  op: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`Matrix ${op} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Matrix mention pills (e.g. @Nora in Element) arrive in `body` as the bare
 * display name ("Nora") but in `formatted_body` as an HTML link:
 *   <a href="https://matrix.to/#/@nora-bot:matrix.org">Nora</a>
 *
 * This function wraps mentioned display names in `<m>Name</m>` markers so that
 * the trigger pattern `^<m>Name</m>` can match them, and bots see a consistent
 * mention format in their context.
 */
export function restoreMentionPrefixes(body: string, formattedBody: string): string {
  // Extract display names from Matrix mention pill links
  const mentionRe = /<a\s+href="https:\/\/matrix\.to\/#\/@[^"]+">([^<]+)<\/a>/gi;
  let match: RegExpExecArray | null;
  const displayNames: string[] = [];
  while ((match = mentionRe.exec(formattedBody)) !== null) {
    displayNames.push(match[1]);
  }
  if (displayNames.length === 0) return body;

  let result = body;
  for (const name of displayNames) {
    // Wrap bare name in <m> markers. Skip if already wrapped or @-prefixed.
    const escaped = escapeRegex(name);
    const re = new RegExp(`(?<!@)(?<!<m>)\\b${escaped}\\b(?!</m>)`, 'g');
    result = result.replace(re, `<m>${name}</m>`);
  }
  return result;
}

/**
 * Convert raw `@Name` mentions in text to `<m>Name</m>` markers using a
 * cache of known Matrix display names. This catches mentions typed without
 * a Matrix mention pill (e.g. plain "@Cid" in body text). The match is
 * case-insensitive and uses word boundaries to avoid false matches on
 * emails (user@example.com) or code (@decorator).
 */
export function convertRawMentions(
  text: string,
  nameCache: ReadonlyMap<string, string>,
): string {
  if (!text.includes('@')) return text;

  // Build a map of lowercase base-name → display name for matching
  const baseNames: { pattern: RegExp; displayName: string }[] = [];
  for (const [, displayName] of nameCache) {
    const baseName = displayName.split(/\s/)[0];
    if (!baseName) continue;
    const escaped = escapeRegex(baseName);
    // Match @Name with word boundary, but not if already inside <m> markers
    baseNames.push({
      pattern: new RegExp(`(?<!<m>)@${escaped}\\b`, 'gi'),
      displayName: baseName,
    });
  }

  let result = text;
  for (const { pattern, displayName } of baseNames) {
    result = result.replace(pattern, `<m>${displayName}</m>`);
  }
  return result;
}

function toJid(roomId: string): string {
  return `matrix:${roomId}`;
}

function toRoomId(jid: string): string {
  return jid.slice('matrix:'.length);
}

function isValidMatrixRoomId(roomId: string): boolean {
  return /^[!#][^:\s]+:[^\s]+$/.test(roomId);
}

function parseRoomIdFromJid(jid: string): string | null {
  if (!jid.startsWith('matrix:')) return null;
  const roomId = toRoomId(jid).trim();
  return isValidMatrixRoomId(roomId) ? roomId : null;
}

function isValidMatrixEventId(eventId: string): boolean {
  return /^\$[^\s]+$/.test(eventId);
}

function isValidMatrixMxcUri(mxcUrl: string): boolean {
  return /^mxc:\/\/[^/\s]+\/[^\s?#]+$/.test(mxcUrl.trim());
}

function sanitizeGroupFolderSegment(folder: string): string | null {
  const trimmed = folder.trim();
  if (!trimmed || trimmed === '.' || trimmed === '..') return null;
  if (trimmed.includes('/') || trimmed.includes('\\')) return null;
  return /^[a-zA-Z0-9._-]+$/.test(trimmed) ? trimmed : null;
}


function isEscaped(text: string, index: number): boolean {
  let slashCount = 0;
  let i = index - 1;
  while (i >= 0 && text[i] === '\\') {
    slashCount++;
    i--;
  }
  return slashCount % 2 === 1;
}

function findClosingSingleDollar(text: string, from: number): number {
  for (let i = from; i < text.length; i++) {
    if (text[i] !== '$') continue;
    if (isEscaped(text, i)) continue;
    if (text[i - 1] === '$' || text[i + 1] === '$') continue;
    return i;
  }
  return -1;
}

function findClosingDoubleDollar(text: string, from: number): number {
  for (let i = from; i < text.length - 1; i++) {
    if (text[i] !== '$' || text[i + 1] !== '$') continue;
    if (isEscaped(text, i)) continue;
    return i;
  }
  return -1;
}

function sanitizeHref(url: string): string | null {
  const trimmed = url.trim();
  if (/^(https?:\/\/|mailto:)/i.test(trimmed)) {
    return escapeHtml(trimmed);
  }
  return null;
}

function sanitizeRenderedHtmlLinks(html: string): string {
  return html.replace(/\shref=(["'])(.*?)\1/gi, (_m, quote, rawUrl: string) => {
    const safe = sanitizeHref(rawUrl);
    if (!safe) return ' href="#"';
    return ` href=${quote}${safe}${quote}`;
  });
}

/**
 * Strips dangerous HTML from the preformatted-HTML bypass path (isPreformattedHtml).
 * Removes script/iframe/object/embed tags, event handler attributes, and
 * javascript:/data: URL schemes. Safe internal uses (<details>, <font>, <small>)
 * are unaffected — they don't contain these patterns.
 */
function sanitizePreformattedHtml(html: string): string {
  return html
    // Remove script, iframe, object, embed with inner content
    .replace(/<(script|iframe|object|embed)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    // Remove self-closing / unclosed versions of the above
    .replace(/<(script|iframe|object|embed)\b[^>]*\/?>/gi, '')
    // Remove event handler attributes (onclick, onerror, onload, etc.)
    .replace(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi, '')
    // Remove javascript: and data: URL schemes in href/src/action
    .replace(/\b(href|src|action)\s*=\s*(?:"(?:javascript|data):[^"]*"|'(?:javascript|data):[^']*')/gi, '$1="#"');
}

function createSafeMarkdownRenderer() {
  const renderer = new marked.Renderer();
  const origListitem = renderer.listitem.bind(renderer);
  renderer.listitem = (item) => {
    const result = origListitem(item);
    return result.replace(/<p>([\s\S]*?)<\/p>/g, '$1');
  };
  renderer.html = (token: any) => {
    const raw = typeof token === 'string'
      ? token
      : (typeof token?.raw === 'string' ? token.raw : (typeof token?.text === 'string' ? token.text : ''));
    return escapeHtml(raw);
  };
  renderer.link = (token: any) => {
    const href = typeof token?.href === 'string' ? token.href : '';
    const text = typeof token?.text === 'string' ? token.text : '';
    const safeHref = sanitizeHref(href);
    const safeText = escapeHtml(text) || escapeHtml(href);
    if (!safeHref) return safeText;
    return `<a href="${safeHref}">${safeText}</a>`;
  };
  renderer.image = (token: any) => {
    const href = typeof token?.href === 'string' ? token.href : '';
    const text = typeof token?.text === 'string' ? token.text : 'image';
    const safeHref = sanitizeHref(href);
    const alt = escapeHtml(text || 'image');
    if (!safeHref) return alt;
    return `<a href="${safeHref}">${alt}</a>`;
  };
  return renderer;
}

function normalizeSenderPrefixForMarkdown(text: string): string {
  const match = text.match(/^([^\n:]{1,160}):\s+([\s\S]+)$/);
  if (!match) return text;
  const sender = match[1].trim();
  const body = match[2];
  if (!sender || !body) return text;
  return `${sender}: \n\n${body}`;
}

async function renderMarkdownForMatrix(text: string): Promise<string> {
  // Strategy: Extract math to protect it, apply markdown, then restore math
  const mathTokens: string[] = [];
  const mathPlaceholder = (htmlStr: string): string => {
    const idx = mathTokens.push(htmlStr) - 1;
    return `@@MATH_${idx}@@`;
  };

  // Extract inline and display math before markdown processing
  let working = text;
  working = working.replace(/\$\$([^\$]+)\$\$/g, (_m, latex) => {
    return mathPlaceholder(`<div data-mx-maths="${escapeHtml(latex.trim())}"><code>${escapeHtml(latex.trim())}</code></div>`);
  });
  working = working.replace(/\$([^\$\n]+)\$/g, (_m, latex) => {
    return mathPlaceholder(`<span data-mx-maths="${escapeHtml(latex.trim())}"><code>${escapeHtml(latex.trim())}</code></span>`);
  });

  const html = await marked(working, {
    breaks: true,
    gfm: true,
    renderer: createSafeMarkdownRenderer(),
  });

  // Restore math placeholders
  return sanitizeRenderedHtmlLinks(
    html.replace(/@@MATH_(\d+)@@/g, (_m, idxText) => mathTokens[Number(idxText)] ?? ''),
  );
}

export function toFormattedBodyWithMarkdownAndMath(text: string): {
  formattedBody: string;
  hasRichFormatting: boolean;
} {
  const tokens: string[] = [];
  const placeholder = (html: string): string => {
    const idx = tokens.push(html) - 1;
    return `@@MATRIX_TOKEN_${idx}@@`;
  };

  let working = text;
  let hasRichFormatting = false;

  working = working.replace(/```([^\n`]*)\n([\s\S]*?)```/g, (_m, _lang, code) => {
    hasRichFormatting = true;
    return placeholder(`<pre><code>${escapeHtml(code)}</code></pre>`);
  });

  working = working.replace(/```\n?([\s\S]*?)```/g, (_m, code) => {
    hasRichFormatting = true;
    return placeholder(`<pre><code>${escapeHtml(code)}</code></pre>`);
  });

  let out = '';
  let i = 0;

  while (i < working.length) {
    if (
      working[i] === '$' &&
      working[i + 1] === '$' &&
      !isEscaped(working, i)
    ) {
      const end = findClosingDoubleDollar(working, i + 2);
      if (end !== -1 && end > i + 2) {
        const latex = working.slice(i + 2, end).trim();
        if (latex.length > 0) {
          const html = `<div data-mx-maths="${escapeHtml(latex)}"><code>${escapeHtml(latex)}</code></div>`;
          out += placeholder(html);
          hasRichFormatting = true;
          i = end + 2;
          continue;
        }
      }
    }

    if (
      working[i] === '$' &&
      working[i + 1] !== '$' &&
      !isEscaped(working, i)
    ) {
      const end = findClosingSingleDollar(working, i + 1);
      if (end !== -1 && end > i + 1) {
        const latex = working.slice(i + 1, end).trim();
        if (latex.length > 0) {
          const html = `<span data-mx-maths="${escapeHtml(latex)}"><code>${escapeHtml(latex)}</code></span>`;
          out += placeholder(html);
          hasRichFormatting = true;
          i = end + 1;
          continue;
        }
      }
    }

    out += working[i];
    i++;
  }

  working = out;

  // Only process inline code - keep markdown syntax for everything else
  working = working.replace(/`([^`\n]+)`/g, (_m, code) => {
    hasRichFormatting = true;
    return placeholder(`<code>${escapeHtml(code)}</code>`);
  });

  // Escape HTML in remaining text but preserve newlines
  working = escapeHtml(working);
  working = working.replace(/\n/g, '<br/>');

  // Restore placeholders (math and code blocks)
  const formattedBody = working.replace(
    /@@MATRIX_TOKEN_(\d+)@@/g,
    (_m, idxText) => tokens[Number(idxText)] ?? '',
  );

  return { formattedBody, hasRichFormatting };
}

function defaultExtensionForMime(mimetype: string): string {
  const map: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/bmp': 'bmp',
    'image/svg+xml': 'svg',
  };
  return map[mimetype.toLowerCase()] || 'bin';
}

function inferImageDimensions(
  buffer: Buffer,
): { width: number; height: number } | null {
  if (buffer.length >= 24 && buffer.slice(0, 8).equals(Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]))) {
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    if (width > 0 && height > 0) return { width, height };
  }

  if (
    buffer.length >= 10 &&
    buffer.slice(0, 3).toString('ascii') === 'GIF'
  ) {
    const width = buffer.readUInt16LE(6);
    const height = buffer.readUInt16LE(8);
    if (width > 0 && height > 0) return { width, height };
  }

  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = buffer[offset + 1];
      if (
        marker === 0xc0 ||
        marker === 0xc1 ||
        marker === 0xc2 ||
        marker === 0xc3 ||
        marker === 0xc5 ||
        marker === 0xc6 ||
        marker === 0xc7 ||
        marker === 0xc9 ||
        marker === 0xca ||
        marker === 0xcb ||
        marker === 0xcd ||
        marker === 0xce ||
        marker === 0xcf
      ) {
        const height = buffer.readUInt16BE(offset + 5);
        const width = buffer.readUInt16BE(offset + 7);
        if (width > 0 && height > 0) return { width, height };
        return null;
      }
      if (marker === 0xd8 || marker === 0xd9) {
        offset += 2;
        continue;
      }
      const segmentLength = buffer.readUInt16BE(offset + 2);
      if (segmentLength < 2) break;
      offset += 2 + segmentLength;
    }
  }

  return null;
}

function matrixErrCode(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const record = err as Record<string, unknown>;
  if (typeof record.errcode === 'string') return record.errcode;
  if (record.body && typeof record.body === 'object') {
    const body = record.body as Record<string, unknown>;
    if (typeof body.errcode === 'string') return body.errcode;
  }
  return undefined;
}

/**
 * Convert <m>Name</m> markers in text/HTML to Matrix mention pills.
 * Bots emit <m>Cid</m> to explicitly mark a mention. This avoids false matches
 * that @-prefix scanning would produce on emails, code, or other @ patterns.
 * The nameCache maps userId → displayName (may include pips); matching uses
 * only the base name (first word), case-insensitive.
 *
 * Any <m>Name</m> that doesn't match a known user is stripped to just "Name".
 */
export function pillifyMentions(
  text: string,
  nameCache: ReadonlyMap<string, string>,
): string {
  if (!text.includes('<m>')) return text;

  // Build reverse map: lowercase base name → userId
  const nameToUser = new Map<string, { userId: string; displayName: string }>();
  for (const [userId, displayName] of nameCache) {
    const baseName = displayName.split(/\s/)[0];
    if (baseName) {
      nameToUser.set(baseName.toLowerCase(), { userId, displayName: baseName });
    }
  }

  return text.replace(/<m>([^<]+)<\/m>/gi, (_full, name: string) => {
    const entry = nameToUser.get(name.trim().toLowerCase());
    if (!entry) return name; // Strip marker, keep name as plain text
    const safeUserId = escapeHtml(entry.userId);
    const safeName = escapeHtml(entry.displayName);
    return `<a href="https://matrix.to/#/${safeUserId}">${safeName}</a>`;
  });
}

export class MatrixChannel implements Channel {
  name = 'matrix';
  prefixAssistantName = false; // Bot display name shows in Matrix

  private client: MatrixClient | null = null;
  private _connected = false;
  private _connecting = false;
  botUserId = MATRIX_USER_ID;
  private opts: MatrixChannelOpts;
  private lastMessageEventId = new Map<string, string>();
  private recentBotEventIds = new Map<string, string[]>();
  private senderNameCache = new Map<string, string>(); // userId → displayname
  private roomNameCache = new Map<string, string>(); // roomId → display name

  // Sequential send queue — prevents concurrent Matrix API calls from racing.
  // No rate limit handling needed: private homeserver (Continuwuity) has no rate limits.
  private _sendQueue: Array<() => Promise<void>> = [];
  private _sendQueueRunning = false;

  constructor(opts: MatrixChannelOpts) {
    this.opts = opts;
    configureMatrixSdkLogger();
  }

  /** Track the last N bot-sent event IDs per room for reaction matching. */
  private trackBotEvent(roomId: string, eventId: string, maxHistory = 10): void {
    const ids = this.recentBotEventIds.get(roomId) ?? [];
    ids.push(eventId);
    if (ids.length > maxHistory) ids.splice(0, ids.length - maxHistory);
    this.recentBotEventIds.set(roomId, ids);
  }

  /**
   * Queue a Matrix API call for sequential execution.
   * Prevents concurrent sends from racing — no rate limit handling needed
   * since the private homeserver (Continuwuity) has no rate limits.
   */
  private enqueueSend<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this._sendQueue.push(async () => {
        try {
          resolve(await fn());
        } catch (err) {
          reject(err);
        }
      });
      void this.drainSendQueue();
    });
  }

  private async drainSendQueue(): Promise<void> {
    if (this._sendQueueRunning) return;
    this._sendQueueRunning = true;
    while (this._sendQueue.length > 0) {
      const task = this._sendQueue.shift()!;
      await task();
    }
    this._sendQueueRunning = false;
  }

  private readStored(
    storage: SimpleFsStorageProvider,
    key: string,
  ): string | undefined {
    const v = storage.readValue(key);
    return typeof v === 'string' && v.trim().length > 0 ? v : undefined;
  }

  private storeTokens(
    storage: SimpleFsStorageProvider,
    data: MatrixLoginResponse,
  ): void {
    if (data.access_token) storage.storeValue(STORAGE_ACCESS_TOKEN, data.access_token);
    if (data.refresh_token) storage.storeValue(STORAGE_REFRESH_TOKEN, data.refresh_token);
    if (data.device_id) storage.storeValue(STORAGE_DEVICE_ID, data.device_id);
    if (data.user_id) storage.storeValue(STORAGE_USER_ID, data.user_id);
  }

  private async postMatrixJson(
    path: string,
    body: Record<string, unknown>,
  ): Promise<MatrixLoginResponse> {
    const url = `${MATRIX_HOMESERVER}${path}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();

    let parsed: unknown = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { error: text || `${res.status} ${res.statusText}` };
    }

    if (!res.ok) {
      const record =
        parsed && typeof parsed === 'object'
          ? (parsed as Record<string, unknown>)
          : {};
      const err = new Error(
        typeof record.error === 'string'
          ? record.error
          : `${res.status} ${res.statusText}`,
      ) as Error & Record<string, unknown>;
      err.statusCode = res.status;
      err.body = record;
      if (typeof record.errcode === 'string') err.errcode = record.errcode;
      if (typeof record.error === 'string') err.error = record.error;
      throw err;
    }

    return parsed as MatrixLoginResponse;
  }

  private async refreshAccessToken(
    refreshToken: string,
  ): Promise<MatrixLoginResponse> {
    return await this.postMatrixJson('/_matrix/client/v3/refresh', {
      refresh_token: refreshToken,
    });
  }

  private async passwordLoginWithRefresh(
    username: string,
    password: string,
    deviceId?: string,
  ): Promise<MatrixLoginResponse> {
    const payload: Record<string, unknown> = {
      type: 'm.login.password',
      identifier: {
        type: 'm.id.user',
        user: username,
      },
      password,
      initial_device_display_name: MATRIX_DEVICE_NAME,
      refresh_token: true,
    };
    if (deviceId) payload.device_id = deviceId;
    return await this.postMatrixJson('/_matrix/client/v3/login', payload);
  }

  private isAuthFailure(err: unknown): boolean {
    const code = matrixErrCode(err);
    return code === 'M_UNKNOWN_TOKEN' || code === 'M_FORBIDDEN';
  }

  private isTooLargeError(err: unknown): boolean {
    return matrixErrCode(err) === 'M_TOO_LARGE';
  }

  private markDisconnected(context: string, err?: unknown): void {
    this._connected = false;
    this._connecting = false;
    if (err) {
      logger.warn({ errcode: matrixErrCode(err), err }, context);
    } else {
      logger.warn(context);
    }
    try {
      this.client?.stop();
    } catch {
      // Best-effort cleanup
    }
    this.client = null;
  }

  private async createAuthedClient(
    storage: SimpleFsStorageProvider,
  ): Promise<MatrixClient | null> {
    const storedAccessToken = this.readStored(storage, STORAGE_ACCESS_TOKEN);
    const storedRefreshToken = this.readStored(storage, STORAGE_REFRESH_TOKEN);
    const storedDeviceId = this.readStored(storage, STORAGE_DEVICE_ID);
    const hasAccessToken = !!MATRIX_ACCESS_TOKEN || !!storedAccessToken;
    const hasPasswordLogin = !!MATRIX_USERNAME && !!MATRIX_PASSWORD;

    if (
      !MATRIX_HOMESERVER ||
      (!hasAccessToken && !hasPasswordLogin && !storedRefreshToken)
    ) {
      return null;
    }

    const validate = async (
      client: MatrixClient,
      source:
        | 'access_token'
        | 'stored_access_token'
        | 'refresh_token'
        | 'password_login',
    ): Promise<MatrixClient> => {
      const whoami = await withTimeout(
        client.getWhoAmI(),
        MATRIX_HEALTH_TIMEOUT_MS,
        'getWhoAmI',
      );
      this.botUserId = whoami.user_id || MATRIX_USER_ID;
      storage.storeValue(STORAGE_USER_ID, this.botUserId);
      logger.info(
        { source, userId: this.botUserId },
        'Matrix auth validated',
      );
      return client;
    };

    if (MATRIX_ACCESS_TOKEN) {
      const tokenClient = new MatrixClient(
        MATRIX_HOMESERVER,
        MATRIX_ACCESS_TOKEN,
        storage,
      );
      try {
        storage.storeValue(STORAGE_ACCESS_TOKEN, MATRIX_ACCESS_TOKEN);
        return await validate(tokenClient, 'access_token');
      } catch (err) {
        logger.warn(
          { errcode: matrixErrCode(err), err },
          'Matrix access token rejected',
        );
      }
    }

    if (storedAccessToken) {
      const tokenClient = new MatrixClient(
        MATRIX_HOMESERVER,
        storedAccessToken,
        storage,
      );
      try {
        return await validate(tokenClient, 'stored_access_token');
      } catch (err) {
        logger.warn(
          { errcode: matrixErrCode(err), err },
          'Stored Matrix access token rejected',
        );
      }
    }

    if (storedRefreshToken) {
      try {
        const refreshed = await this.refreshAccessToken(storedRefreshToken);
        if (!refreshed.access_token) {
          throw new Error('refresh endpoint returned no access_token');
        }
        this.storeTokens(storage, refreshed);
        const refreshClient = new MatrixClient(
          MATRIX_HOMESERVER,
          refreshed.access_token,
          storage,
        );
        return await validate(refreshClient, 'refresh_token');
      } catch (err) {
        logger.warn(
          { errcode: matrixErrCode(err), err },
          'Matrix refresh token flow failed',
        );
      }
    }

    if (hasPasswordLogin) {
      try {
        const login = await this.passwordLoginWithRefresh(
          MATRIX_USERNAME,
          MATRIX_PASSWORD,
          storedDeviceId,
        );
        if (!login.access_token) {
          throw new Error('password login returned no access_token');
        }
        this.storeTokens(storage, login);
        const passwordClient = new MatrixClient(
          MATRIX_HOMESERVER,
          login.access_token,
          storage,
        );
        return await validate(passwordClient, 'password_login');
      } catch (err) {
        logger.warn(
          { errcode: matrixErrCode(err), err },
          'Password login with refresh failed, falling back to MatrixAuth',
        );
      }

      const auth = new MatrixAuth(MATRIX_HOMESERVER);
      const loggedIn = await auth.passwordLogin(
        MATRIX_USERNAME,
        MATRIX_PASSWORD,
        MATRIX_DEVICE_NAME,
      );
      const passwordClient = new MatrixClient(
        MATRIX_HOMESERVER,
        loggedIn.accessToken,
        storage,
      );
      return await validate(passwordClient, 'password_login');
    }

    logger.error(
      {
        hasEnvAccessToken: !!MATRIX_ACCESS_TOKEN,
        hasStoredAccessToken: !!storedAccessToken,
        hasStoredRefreshToken: !!storedRefreshToken,
        hasPasswordLogin,
      },
      'Matrix auth failed: no valid token/login available',
    );
    return null;
  }

  async connect(): Promise<void> {
    if (this._connected || this._connecting) return;
    this._connecting = true;

    if (!MATRIX_HOMESERVER) {
      logger.debug('Matrix not configured, channel dormant');
      return;
    }

    const storage = new SimpleFsStorageProvider(`${STORE_DIR}/matrix-bot.json`);
    const client = await this.createAuthedClient(storage);
    if (!client) {
      logger.debug('Matrix not configured, channel dormant');
      return;
    }
    this.client = client;

    // Auto-join rooms when invited (with error handling)
    client.on('room.invite', async (roomId: string) => {
      try {
        await client.joinRoom(roomId);
        logger.info({ roomId }, 'Auto-joined Matrix room');
      } catch (err) {
        logger.warn({ roomId, err }, 'Failed to auto-join Matrix room');
      }
    });

    // Listen for reactions (m.reaction events)
    client.on('room.event', async (roomId: string, event: Record<string, unknown>) => {
      if (event.type !== 'm.reaction') return;
      if (event.sender === this.botUserId) return;
      const content = event.content as Record<string, unknown> | undefined;
      const relatesTo = content?.['m.relates_to'] as Record<string, unknown> | undefined;
      const emoji = relatesTo?.key as string | undefined;
      const reactedToId = relatesTo?.event_id as string | undefined;
      if (!emoji || !reactedToId) return;

      const matrixJid = toJid(roomId);
      const groups = this.opts.registeredGroups();
      if (!groups[matrixJid]) return;

      // Only deliver reactions to the bot's own recent messages to avoid flooding
      const recentBotEvents = this.recentBotEventIds.get(roomId) ?? [];
      if (!recentBotEvents.includes(reactedToId)) return;

      const timestamp = new Date(event.origin_server_ts as number).toISOString();
      const senderName = await this.getSenderName(event.sender as string);

      const msg: NewMessage = {
        id: `reaction-${event.event_id as string}`,
        chat_jid: matrixJid,
        sender: event.sender as string,
        sender_name: senderName,
        content: `[reaction: ${emoji} to message ${reactedToId}]`,
        timestamp,
      };

      logger.debug({ matrixJid, emoji, reactedToId }, 'Matrix reaction delivered to onMessage');
      this.opts.onMessage(matrixJid, msg);
    });

    // Listen for messages
    client.on('room.message', async (roomId: string, event: Record<string, unknown>) => {
      if (event.event_id && typeof event.event_id === 'string') {
        this.lastMessageEventId.set(roomId, event.event_id);
      }
      logger.debug({ roomId, sender: event.sender }, 'Matrix room.message event');
      if (!event.content) return;
      const content = event.content as Record<string, unknown>;
      const msgtype = content.msgtype as string | undefined;
      if (msgtype !== 'm.text' && !MEDIA_MSGTYPES.includes(msgtype as string)) return;

      // Ignore own messages
      if (event.sender === this.botUserId) return;

      const matrixJid = toJid(roomId);
      const timestamp = new Date(event.origin_server_ts as number).toISOString();
      const senderName = await this.getSenderName(event.sender as string);

      // Notify metadata for room discovery
      const roomName = await this.getRoomName(roomId);
      this.opts.onChatMetadata(matrixJid, timestamp, roomName);

      // Only deliver full messages for registered rooms (but ! commands bypass)
      const groups = this.opts.registeredGroups();
      const body = msgtype === 'm.text' ? (content.body as string || '') : '';
      if (!groups[matrixJid] && !body.startsWith('!')) {
        logger.debug({ matrixJid, registeredJids: Object.keys(groups) }, 'Matrix message from unregistered room');
        return;
      }

      // Extract thread ID from m.relates_to (MSC3440)
      const relatesTo = content['m.relates_to'] as Record<string, unknown> | undefined;

      // Ignore edit events (m.replace) — these are status indicator updates, not new messages
      if (relatesTo?.rel_type === 'm.replace') return;

      const threadId = relatesTo?.rel_type === 'm.thread' ? (relatesTo.event_id as string) : undefined;

      let messageContent: string;

      if (msgtype === 'm.text') {
        messageContent = content.body as string;
        // Matrix mention pills appear as bare names in body text.
        // Wrap them in <m>Name</m> markers using formatted_body so trigger patterns match.
        const formattedBody = content.formatted_body as string | undefined;
        if (formattedBody) {
          messageContent = restoreMentionPrefixes(messageContent, formattedBody);
        }
        // Convert raw @Name mentions to <m>Name</m> — captain and operator only.
        // Bots may emit raw @Name in code output; rewriting those would corrupt content.
        if ((CAPTAIN_USER_ID && event.sender === CAPTAIN_USER_ID) ||
            (OPERATOR_USER_ID && event.sender === OPERATOR_USER_ID)) {
          messageContent = convertRawMentions(messageContent, this.senderNameCache);
        }
      } else {
        // Media message — download and save to IPC media dir
        const group = groups[matrixJid];
        const filename = (content.body as string) || 'attachment';
        const mxcUrl = content.url as string | undefined;
        const mediaLabel = msgtype === 'm.image' ? 'image' : msgtype === 'm.video' ? 'video' : msgtype === 'm.audio' ? 'audio' : 'file';

        if (mxcUrl) {
          const containerPath = await this.downloadMedia(mxcUrl, filename, group.folder);
          if (containerPath) {
            messageContent = `[Uploaded ${mediaLabel}: ${filename} — saved to ${containerPath}]`;
          } else {
            messageContent = `[Uploaded ${mediaLabel}: ${filename} — download failed]`;
          }
        } else {
          messageContent = `[Uploaded ${mediaLabel}: ${filename} — no download URL]`;
        }

        // Some clients include a caption in formatted_body distinct from the filename
        const bodyText = content.body as string | undefined;
        const filenameField = content.filename as string | undefined;
        if (bodyText && filenameField && bodyText !== filenameField) {
          messageContent += `\nCaption: ${bodyText}`;
        }
      }

      const msg: NewMessage = {
        id: event.event_id as string,
        chat_jid: matrixJid,
        sender: event.sender as string,
        sender_name: senderName,
        content: messageContent,
        timestamp,
        thread_id: threadId,
      };

      logger.debug({ matrixJid, content: messageContent }, 'Matrix message delivered to onMessage');
      this.opts.onMessage(matrixJid, msg);
    });

    // Reduce sync traffic: don't send/receive presence updates
    client.syncingPresence = 'offline' as any;

    try {
      await withTimeout(client.start(), MATRIX_CONNECT_TIMEOUT_MS, 'client.start');
      this._connected = true;
      logger.info('Connected to Matrix');
      if (this.opts.displayName) {
        client.setDisplayName(this.opts.displayName).catch((err) => {
          logger.warn({ err }, 'Failed to set display name');
        });
      }
    } catch (err) {
      this.markDisconnected('Failed to connect to Matrix', err);
      throw err;
    }

  }

  /** Update the bot's Matrix display name (e.g. for CO badge changes). */
  async setDisplayName(name: string): Promise<void> {
    if (!this.client || !this._connected) return;
    try {
      await this.client.setDisplayName(name);
    } catch (err) {
      logger.warn({ err, name }, 'Failed to update display name');
    }
  }

  private async sendTextReturningId(jid: string, text: string, threadId?: string): Promise<string | undefined> {
    if (!this.client || !this._connected) return undefined;
    const roomId = parseRoomIdFromJid(jid);
    if (!roomId) {
      logger.warn({ jid }, 'Invalid Matrix room jid; send skipped');
      return undefined;
    }
    if (threadId) {
      logger.info({ roomId, threadId }, 'Matrix sendMessage with thread');
    }
    const normalizedText = normalizeSenderPrefixForMarkdown(text);
    // If text STARTS with an HTML tag, treat it as preformatted HTML and skip markdown.
    // This covers: <details> tool call blocks, <font> status messages, <small> headers.
    // We do NOT match HTML anywhere in the text — markdown content may contain inline HTML
    // (e.g. delegate headers) and marked handles that fine.
    const isPreformattedHtml = /^<(details|font|small)\b/i.test(text.trimStart());

    let html: string;
    if (isPreformattedHtml) {
      html = sanitizePreformattedHtml(text);
    } else {
      html = await renderMarkdownForMatrix(normalizedText);
    }

    html = this.pillifyMentions(html);

    // Strip <m>Name</m> markers from plaintext body (pills are in formatted_body)
    const plainBody = normalizedText.replace(/<m>([^<]+)<\/m>/gi, '$1');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const msgContent: Record<string, any> = {
      msgtype: 'm.text',
      body: plainBody,
      format: 'org.matrix.custom.html',
      formatted_body: html.trim(),
    };

    // MSC3440 thread support
    if (threadId) {
      msgContent['m.relates_to'] = {
        rel_type: 'm.thread',
        event_id: threadId,
        is_falling_back: false,
      };
    }

    return this.enqueueSend(async () => {
      const eventId = await withTimeout(
        this.client!.sendMessage(roomId, msgContent),
        MATRIX_SEND_TIMEOUT_MS,
        'sendMessage',
      );
      if (eventId) this.trackBotEvent(roomId, eventId);
      return eventId;
    });
  }

  async sendMessage(jid: string, text: string, threadId?: string): Promise<void> {
    try {
      await this.sendTextReturningId(jid, text, threadId);
    } catch (err) {
      if (this.isTooLargeError(err) && text.length > 2000) {
        // Truncate and retry once for oversized messages
        const truncated = text.slice(0, 16_000) + '\n\n…(truncated — message too large for Matrix)';
        logger.warn({ jid, originalLen: text.length }, 'Message too large, retrying truncated');
        try {
          await this.sendTextReturningId(jid, truncated, threadId);
          return;
        } catch (retryErr) { logger.warn({ jid, retryErr }, 'Truncated message retry also failed'); }
      }
      if (this.isAuthFailure(err)) {
        this.markDisconnected('Matrix auth failed while sending message', err);
      }
      logger.warn({ jid, err }, 'Failed to send Matrix message');
    }
  }

  async sendReaction(jid: string, eventId: string, emoji: string): Promise<void> {
    if (!this.client || !this._connected) return;
    const roomId = parseRoomIdFromJid(jid);
    if (!roomId) {
      logger.warn({ jid }, 'Invalid Matrix room jid; reaction skipped');
      return;
    }
    if (!isValidMatrixEventId(eventId)) {
      logger.warn({ eventId }, 'Invalid Matrix event id; reaction skipped');
      return;
    }
    try {
      const content = {
        'm.relates_to': {
          rel_type: 'm.annotation',
          event_id: eventId,
          key: emoji,
        },
      };
      await this.enqueueSend(() => withTimeout(
        this.client!.sendEvent(roomId, 'm.reaction', content),
        MATRIX_SEND_TIMEOUT_MS,
        'sendReaction',
      ));
    } catch (err) {
      if (this.isAuthFailure(err)) {
        this.markDisconnected('Matrix auth failed while sending reaction', err);
      }
      logger.warn({ jid, eventId, err }, 'Failed to send Matrix reaction');
    }
  }

  async sendMessageReturningId(jid: string, text: string, threadId?: string): Promise<string | undefined> {
    try {
      return await this.sendTextReturningId(jid, text, threadId);
    } catch (err) {
      logger.warn({ jid, err }, 'Failed to send Matrix message (returning id)');
      return undefined;
    }
  }

  async editMessage(jid: string, eventId: string, newText: string): Promise<void> {
    if (!this.client || !this._connected) return;
    const roomId = parseRoomIdFromJid(jid);
    if (!roomId) {
      logger.warn({ jid }, 'Invalid Matrix room jid; edit skipped');
      return;
    }
    if (!isValidMatrixEventId(eventId)) {
      logger.warn({ eventId }, 'Invalid Matrix event id; edit skipped');
      return;
    }
    try {
      const normalizedEdit = normalizeSenderPrefixForMarkdown(newText);
      const isPreformattedHtml = /^<(details|font|small)\b/i.test(newText.trimStart());
      let editHtml: string;
      if (isPreformattedHtml) {
        editHtml = sanitizePreformattedHtml(newText);
      } else {
        editHtml = (await renderMarkdownForMatrix(normalizedEdit)).trim();
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const newContent: Record<string, any> = {
        msgtype: 'm.text',
        body: newText,
        format: 'org.matrix.custom.html',
        formatted_body: editHtml,
      };
      const content = {
        msgtype: 'm.text',
        body: `* ${newText}`,
        format: 'org.matrix.custom.html',
        formatted_body: `* ${editHtml}`,
        'm.new_content': newContent,
        'm.relates_to': {
          rel_type: 'm.replace',
          event_id: eventId,
        },
      };
      await this.enqueueSend(() => withTimeout(
        this.client!.sendMessage(roomId, content),
        MATRIX_SEND_TIMEOUT_MS,
        'editMessage',
      ));
    } catch (err) {
      if (this.isTooLargeError(err) && newText.length > 2000) {
        const truncated = newText.slice(0, 16_000) + '\n\n…(truncated)';
        try {
          const truncHtml = truncated.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          const truncContent: Record<string, any> = { // eslint-disable-line @typescript-eslint/no-explicit-any
            msgtype: 'm.text',
            body: `* ${truncated}`,
            format: 'org.matrix.custom.html',
            formatted_body: `* ${truncHtml}`,
            'm.new_content': {
              msgtype: 'm.text',
              body: truncated,
              format: 'org.matrix.custom.html',
              formatted_body: truncHtml,
            },
            'm.relates_to': { rel_type: 'm.replace', event_id: eventId },
          };
          await this.enqueueSend(() => withTimeout(
            this.client!.sendMessage(roomId, truncContent),
            MATRIX_SEND_TIMEOUT_MS,
            'editMessage(truncated)',
          ));
          return;
        } catch (retryErr) { logger.warn({ jid, eventId, retryErr }, 'Truncated edit retry also failed'); }
      }
      logger.warn({ jid, eventId, err }, 'Failed to edit Matrix message');
    }
  }

  async redactMessage(jid: string, eventId: string): Promise<void> {
    if (!this.client || !this._connected) return;
    const roomId = parseRoomIdFromJid(jid);
    if (!roomId) {
      logger.warn({ jid }, 'Invalid Matrix room jid; redact skipped');
      return;
    }
    if (!isValidMatrixEventId(eventId)) {
      logger.warn({ eventId }, 'Invalid Matrix event id; redact skipped');
      return;
    }
    try {
      await this.enqueueSend(() => withTimeout(
        this.client!.redactEvent(roomId, eventId),
        MATRIX_SEND_TIMEOUT_MS,
        'redactMessage',
      ));
    } catch (err) {
      logger.warn({ jid, eventId, err }, 'Failed to redact Matrix message');
    }
  }

  isConnected(): boolean {
    return this._connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('matrix:');
  }

  async disconnect(): Promise<void> {
    this._connected = false;
    try {
      this.client?.stop();
    } catch {
      // Best-effort cleanup
    }
    this.client = null;
  }

  async checkHealth(): Promise<boolean> {
    if (!this.client || !this._connected) return false;
    try {
      await withTimeout(
        this.client.getWhoAmI(),
        MATRIX_HEALTH_TIMEOUT_MS,
        'health check getWhoAmI',
      );
      return true;
    } catch (err) {
      this.markDisconnected('Matrix health check failed', err);
      return false;
    }
  }

  async sendImage(jid: string, buffer: Buffer, filename: string, mimetype: string, caption?: string): Promise<void> {
    return this.sendMedia('image', jid, buffer, filename, mimetype, caption);
  }

  async sendFile(jid: string, buffer: Buffer, filename: string, mimetype: string, caption?: string): Promise<void> {
    return this.sendMedia('file', jid, buffer, filename, mimetype, caption);
  }

  private async sendMedia(
    kind: 'image' | 'file',
    jid: string, buffer: Buffer, filename: string, mimetype: string, caption?: string,
  ): Promise<void> {
    if (!this.client || !this._connected) return;
    const roomId = parseRoomIdFromJid(jid);
    if (!roomId) {
      logger.warn({ jid }, `Invalid Matrix room jid; ${kind} send skipped`);
      return;
    }
    const isImage = kind === 'image';
    const defaultName = isImage ? 'image' : 'attachment';
    const msgtype = isImage ? 'm.image' : 'm.file';
    try {
      logger.info({ filename, mimetype, size: buffer.length }, `Uploading ${kind} to Matrix`);
      const mxcUrl = await this.enqueueSend(() => withTimeout(
        this.client!.uploadContent(buffer, mimetype, filename),
        MATRIX_UPLOAD_TIMEOUT_MS,
        `uploadContent(${kind})`,
      ));
      logger.info({ mxcUrl, filename }, `${kind} uploaded, sending to room`);
      const effectiveFilename = filename?.trim()
        ? filename.trim()
        : `${defaultName}.${defaultExtensionForMime(mimetype)}`;
      const info: Record<string, unknown> = { mimetype, size: buffer.length };
      if (isImage) {
        const dimensions = inferImageDimensions(buffer);
        if (dimensions) {
          info.w = dimensions.width;
          info.h = dimensions.height;
        }
        // Compatibility: some Matrix clients rely on thumbnail fields to decide
        // whether an m.image can be previewed inline.
        info.thumbnail_url = mxcUrl;
        const thumbnailInfo: Record<string, unknown> = { mimetype, size: buffer.length };
        if (dimensions) {
          thumbnailInfo.w = dimensions.width;
          thumbnailInfo.h = dimensions.height;
        }
        info.thumbnail_info = thumbnailInfo;
      }
      const content: Record<string, unknown> = {
        msgtype,
        body: effectiveFilename,
        filename: effectiveFilename,
        url: mxcUrl,
        info,
      };
      const eventId = await this.enqueueSend(() => withTimeout(
        this.client!.sendMessage(roomId, content),
        MATRIX_SEND_TIMEOUT_MS,
        `sendMessage(${kind})`,
      ));
      if (eventId) this.trackBotEvent(roomId, eventId);
      if (caption && caption.trim()) {
        await this.sendMessage(jid, caption.trim());
      }
      logger.info({ roomId, filename }, `${kind} message sent`);
    } catch (err) {
      if (this.isAuthFailure(err)) {
        this.markDisconnected(`Matrix auth failed while sending ${kind}`, err);
      }
      logger.warn({ jid, filename, err }, `Failed to send Matrix ${kind}`);
    }
  }

  async setPresenceStatus(state: string, statusMessage?: string): Promise<void> {
    if (!this.client || !this._connected) return;
    try {
      await this.client.setPresenceStatus(state as any, statusMessage);
    } catch {
      // Non-critical
    }
  }

  async setStatusPip(_jid: string, _emoji: string): Promise<void> {
    // Pip reactions disabled
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.client || !this._connected) return;
    const roomId = parseRoomIdFromJid(jid);
    if (!roomId) return;
    try {
      await withTimeout(
        this.client.setTyping(roomId, isTyping, 30000),
        MATRIX_TYPING_TIMEOUT_MS,
        'setTyping',
      );
    } catch {
      // Non-critical
    }
  }

  private async downloadMedia(mxcUrl: string, filename: string, groupFolder: string): Promise<string | null> {
    if (!this.client) return null;
    if (!isValidMatrixMxcUri(mxcUrl)) {
      logger.warn({ mxcUrl }, 'Invalid Matrix MXC URL; media download skipped');
      return null;
    }
    const safeGroupFolder = sanitizeGroupFolderSegment(groupFolder);
    if (!safeGroupFolder) {
      logger.warn({ groupFolder }, 'Unsafe group folder; media download skipped');
      return null;
    }
    try {
      const { data, contentType } = await withTimeout(
        this.client.downloadContent(mxcUrl),
        30_000,
        'downloadContent',
      );

      if (data.length > MEDIA_MAX_BYTES) {
        logger.warn({ filename, size: data.length, limit: MEDIA_MAX_BYTES }, 'Media file too large, skipping download');
        return null;
      }

      // Sanitize filename: strip path separators, limit length
      const sanitized = filename.replace(/[/\\]/g, '_').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
      const safeFilename = sanitized || 'attachment.bin';
      const timestamped = `${Date.now()}-${safeFilename}`;

      const ipcRoot = path.resolve(DATA_DIR, 'ipc');
      const mediaDir = path.resolve(ipcRoot, safeGroupFolder, 'media');
      const allowedPrefix = `${ipcRoot}${path.sep}`;
      if (!mediaDir.startsWith(allowedPrefix)) {
        logger.warn({ mediaDir, ipcRoot }, 'Resolved media path escaped IPC root; download skipped');
        return null;
      }
      fs.mkdirSync(mediaDir, { recursive: true });

      const hostPath = path.join(mediaDir, timestamped);
      fs.writeFileSync(hostPath, data);

      const containerPath = `/workspace/ipc/${safeGroupFolder}/media/${timestamped}`;
      logger.info({ filename, contentType, size: data.length, containerPath }, 'Media downloaded to IPC');
      return containerPath;
    } catch (err) {
      logger.warn({ mxcUrl, filename, err }, 'Failed to download media from Matrix');
      return null;
    }
  }

  private async getSenderName(userId: string): Promise<string> {
    const cached = this.senderNameCache.get(userId);
    if (cached) return cached;
    if (!this.client) return userId;
    try {
      const profile = await withTimeout(
        this.client.getUserProfile(userId),
        MATRIX_META_TIMEOUT_MS,
        'getUserProfile',
      );
      const name = profile.displayname || userId.split(':')[0].slice(1);
      if (this.senderNameCache.size >= 500) this.senderNameCache.clear();
      this.senderNameCache.set(userId, name);
      return name;
    } catch {
      return userId.split(':')[0].slice(1);
    }
  }

  private pillifyMentions(html: string): string {
    return pillifyMentions(html, this.senderNameCache);
  }

  private async getRoomName(roomId: string): Promise<string> {
    const cached = this.roomNameCache.get(roomId);
    if (cached) return cached;
    if (!this.client) return roomId;
    try {
      const state = await withTimeout(
        this.client.getRoomStateEvent(roomId, 'm.room.name', ''),
        MATRIX_META_TIMEOUT_MS,
        'getRoomStateEvent(m.room.name)',
      );
      const name = state.name || roomId;
      if (this.roomNameCache.size >= 200) this.roomNameCache.clear();
      this.roomNameCache.set(roomId, name);
      return name;
    } catch {
      return roomId;
    }
  }
}
