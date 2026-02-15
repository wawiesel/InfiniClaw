import {
  MatrixClient,
  MatrixAuth,
  SimpleFsStorageProvider,
} from 'matrix-bot-sdk';

import {
  MATRIX_ACCESS_TOKEN,
  MATRIX_DEVICE_NAME,
  MATRIX_HOMESERVER,
  MATRIX_PASSWORD,
  MATRIX_USER_ID,
  MATRIX_USERNAME,
  STORE_DIR,
} from '../config.js';
import { logger } from '../logger.js';
import {
  Channel,
  NewMessage,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface MatrixChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

interface MatrixLoginResponse {
  access_token?: string;
  refresh_token?: string;
  user_id?: string;
  device_id?: string;
  expires_in_ms?: number;
}

const STORAGE_ACCESS_TOKEN = 'matrix_access_token';
const STORAGE_REFRESH_TOKEN = 'matrix_refresh_token';
const STORAGE_DEVICE_ID = 'matrix_device_id';
const STORAGE_USER_ID = 'matrix_user_id';
const MATRIX_SEND_TIMEOUT_MS = 4_000;
const MATRIX_TYPING_TIMEOUT_MS = 1_500;
const MATRIX_META_TIMEOUT_MS = 2_500;
const MATRIX_HEALTH_TIMEOUT_MS = 5_000;

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

function toJid(roomId: string): string {
  return `matrix:${roomId}`;
}

function toRoomId(jid: string): string {
  return jid.slice('matrix:'.length);
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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
  if (/^(https?:\/\/|mailto:|file:\/\/)/i.test(trimmed)) {
    return escapeHtml(trimmed);
  }
  return null;
}

function normalizeSenderPrefixForMarkdown(text: string): string {
  const match = text.match(/^([^\n:]{1,160}):\s+([\s\S]+)$/);
  if (!match) return text;
  const sender = match[1].trim();
  const body = match[2];
  if (!sender || !body) return text;
  return `${sender}: \n\n${body}`;
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
  working = working.replace(/`([^`\n]+)`/g, (_m, code) => {
    hasRichFormatting = true;
    return placeholder(`<code>${escapeHtml(code)}</code>`);
  });

  working = escapeHtml(working);

  working = working.replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g, (_m, label, href) => {
    const safeHref = sanitizeHref(href);
    if (!safeHref) return _m;
    hasRichFormatting = true;
    return `<a href="${safeHref}">${label}</a>`;
  });
  working = working.replace(/\*\*([^*\n]+)\*\*/g, (_m, textPart) => {
    hasRichFormatting = true;
    return `<strong>${textPart}</strong>`;
  });
  working = working.replace(/~~([^~\n]+)~~/g, (_m, textPart) => {
    hasRichFormatting = true;
    return `<del>${textPart}</del>`;
  });
  working = working.replace(/\*([^*\n]+)\*/g, (_m, textPart) => {
    hasRichFormatting = true;
    return `<em>${textPart}</em>`;
  });
  working = working.replace(/\n/g, '<br/>');

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

export class MatrixChannel implements Channel {
  name = 'matrix';
  prefixAssistantName = false; // Bot display name shows in Matrix

  private client: MatrixClient | null = null;
  private _connected = false;
  private botUserId = MATRIX_USER_ID;
  private opts: MatrixChannelOpts;

  constructor(opts: MatrixChannelOpts) {
    this.opts = opts;
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

  private markDisconnected(context: string, err?: unknown): void {
    this._connected = false;
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
    if (this._connected) return;

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

    // Listen for messages
    client.on('room.message', async (roomId: string, event: Record<string, unknown>) => {
      logger.debug({ roomId, sender: event.sender }, 'Matrix room.message event');
      if (!event.content) return;
      const content = event.content as Record<string, unknown>;
      if (content.msgtype !== 'm.text') return;

      // Ignore own messages
      if (event.sender === this.botUserId) return;

      const matrixJid = toJid(roomId);
      const timestamp = new Date(event.origin_server_ts as number).toISOString();
      const senderName = await this.getSenderName(event.sender as string);

      // Notify metadata for room discovery
      const roomName = await this.getRoomName(roomId);
      this.opts.onChatMetadata(matrixJid, timestamp, roomName);

      // Only deliver full messages for registered rooms
      const groups = this.opts.registeredGroups();
      if (!groups[matrixJid]) {
        logger.debug({ matrixJid, registeredJids: Object.keys(groups) }, 'Matrix message from unregistered room');
        return;
      }

      const msg: NewMessage = {
        id: event.event_id as string,
        chat_jid: matrixJid,
        sender: event.sender as string,
        sender_name: senderName,
        content: content.body as string,
        timestamp,
      };

      logger.debug({ matrixJid, content: content.body }, 'Matrix message delivered to onMessage');
      this.opts.onMessage(matrixJid, msg);
    });

    try {
      await withTimeout(client.start(), MATRIX_HEALTH_TIMEOUT_MS, 'client.start');
      this._connected = true;
      logger.info('Connected to Matrix');
    } catch (err) {
      this.markDisconnected('Failed to connect to Matrix', err);
      throw err;
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.client || !this._connected) return;
    const roomId = toRoomId(jid);
    const normalizedText = normalizeSenderPrefixForMarkdown(text);
    const { formattedBody, hasRichFormatting } =
      toFormattedBodyWithMarkdownAndMath(normalizedText);
    try {
      if (hasRichFormatting) {
        await withTimeout(
          this.client.sendMessage(roomId, {
            msgtype: 'm.text',
            body: normalizedText,
            format: 'org.matrix.custom.html',
            formatted_body: formattedBody,
          }),
          MATRIX_SEND_TIMEOUT_MS,
          'sendMessage',
        );
      } else {
        await withTimeout(
          this.client.sendText(roomId, normalizedText),
          MATRIX_SEND_TIMEOUT_MS,
          'sendText',
        );
      }
    } catch (err) {
      if (this.isAuthFailure(err)) {
        this.markDisconnected('Matrix auth failed while sending message', err);
      }
      logger.warn({ jid, err }, 'Failed to send Matrix message');
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
    if (!this.client || !this._connected) return;
    const roomId = toRoomId(jid);
    try {
      logger.info({ filename, mimetype, size: buffer.length }, 'Uploading image to Matrix');
      const mxcUrl = await withTimeout(
        this.client.uploadContent(buffer, mimetype, filename),
        MATRIX_SEND_TIMEOUT_MS,
        'uploadContent(image)',
      );
      logger.info({ mxcUrl, filename }, 'Image uploaded, sending to room');
      const effectiveFilename = filename?.trim()
        ? filename.trim()
        : `image.${defaultExtensionForMime(mimetype)}`;
      const dimensions = inferImageDimensions(buffer);
      const info: Record<string, unknown> = {
        mimetype,
        size: buffer.length,
      };
      if (dimensions) {
        info.w = dimensions.width;
        info.h = dimensions.height;
      }
      // Compatibility: some Matrix clients rely on thumbnail fields to decide
      // whether an m.image can be previewed inline.
      info.thumbnail_url = mxcUrl;
      const thumbnailInfo: Record<string, unknown> = {
        mimetype,
        size: buffer.length,
      };
      if (dimensions) {
        thumbnailInfo.w = dimensions.width;
        thumbnailInfo.h = dimensions.height;
      }
      info.thumbnail_info = thumbnailInfo;
      const content: Record<string, unknown> = {
        msgtype: 'm.image',
        body: effectiveFilename,
        filename: effectiveFilename,
        url: mxcUrl,
        info,
      };
      await withTimeout(
        this.client.sendMessage(roomId, content),
        MATRIX_SEND_TIMEOUT_MS,
        'sendMessage(image)',
      );
      if (caption && caption.trim()) {
        await this.sendMessage(jid, caption.trim());
      }
      logger.info({ roomId, filename }, 'Image message sent');
    } catch (err) {
      if (this.isAuthFailure(err)) {
        this.markDisconnected('Matrix auth failed while sending image', err);
      }
      logger.warn({ jid, filename, err }, 'Failed to send Matrix image');
    }
  }

  async sendFile(jid: string, buffer: Buffer, filename: string, mimetype: string, caption?: string): Promise<void> {
    if (!this.client || !this._connected) return;
    const roomId = toRoomId(jid);
    try {
      logger.info({ filename, mimetype, size: buffer.length }, 'Uploading file to Matrix');
      const mxcUrl = await withTimeout(
        this.client.uploadContent(buffer, mimetype, filename),
        MATRIX_SEND_TIMEOUT_MS,
        'uploadContent(file)',
      );
      logger.info({ mxcUrl, filename }, 'File uploaded, sending to room');
      const effectiveFilename = filename?.trim()
        ? filename.trim()
        : `attachment.${defaultExtensionForMime(mimetype)}`;
      const content: Record<string, unknown> = {
        msgtype: 'm.file',
        body: effectiveFilename,
        filename: effectiveFilename,
        url: mxcUrl,
        info: {
          mimetype,
          size: buffer.length,
        },
      };
      await withTimeout(
        this.client.sendMessage(roomId, content),
        MATRIX_SEND_TIMEOUT_MS,
        'sendMessage(file)',
      );
      if (caption && caption.trim()) {
        await this.sendMessage(jid, caption.trim());
      }
      logger.info({ roomId, filename }, 'File message sent');
    } catch (err) {
      if (this.isAuthFailure(err)) {
        this.markDisconnected('Matrix auth failed while sending file', err);
      }
      logger.warn({ jid, filename, err }, 'Failed to send Matrix file');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.client || !this._connected) return;
    const roomId = toRoomId(jid);
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

  private async getSenderName(userId: string): Promise<string> {
    if (!this.client) return userId;
    try {
      const profile = await withTimeout(
        this.client.getUserProfile(userId),
        MATRIX_META_TIMEOUT_MS,
        'getUserProfile',
      );
      return profile.displayname || userId.split(':')[0].slice(1);
    } catch {
      return userId.split(':')[0].slice(1);
    }
  }

  private async getRoomName(roomId: string): Promise<string> {
    if (!this.client) return roomId;
    try {
      const state = await withTimeout(
        this.client.getRoomStateEvent(roomId, 'm.room.name', ''),
        MATRIX_META_TIMEOUT_MS,
        'getRoomStateEvent(m.room.name)',
      );
      return state.name || roomId;
    } catch {
      return roomId;
    }
  }
}
