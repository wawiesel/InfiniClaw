import fs from 'fs';
import path from 'path';
import { MatrixClient, MatrixAuth, LogService, LogLevel, SimpleFsStorageProvider, } from 'matrix-bot-sdk';
import { marked } from 'marked';
import { DATA_DIR, STORE_DIR } from 'nanoclaw/config.js';
import { MATRIX_ACCESS_TOKEN, MATRIX_DEVICE_NAME, MATRIX_HOMESERVER, MATRIX_PASSWORD, MATRIX_USER_ID, MATRIX_USERNAME, } from '../infini-config.js';
import { logger } from 'nanoclaw/logger.js';
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
function isExpectedAccountDataMissing(args) {
    return args.some((arg) => {
        if (!arg || typeof arg !== 'object')
            return false;
        const record = arg;
        const errcode = typeof record.errcode === 'string'
            ? record.errcode
            : typeof record.body?.errcode ===
                'string'
                ? record.body.errcode
                : undefined;
        const message = typeof record.error === 'string'
            ? record.error
            : typeof record.body?.error ===
                'string'
                ? record.body.error
                : '';
        return errcode === 'M_NOT_FOUND' && message === 'Account data not found';
    });
}
function configureMatrixSdkLogger() {
    if (matrixSdkLoggerConfigured)
        return;
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
async function withTimeout(promise, timeoutMs, op) {
    let timer;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timer = setTimeout(() => {
                    reject(new Error(`Matrix ${op} timed out after ${timeoutMs}ms`));
                }, timeoutMs);
            }),
        ]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
/**
 * Matrix mention pills (e.g. @Nora in Element) arrive in `body` as the bare
 * display name ("Nora") but in `formatted_body` as an HTML link:
 *   <a href="https://matrix.to/#/@nora-bot:matrix.org">Nora</a>
 *
 * This function restores the `@` prefix on mentioned display names so that
 * trigger patterns like `@Nora\b` can match them.
 */
function restoreMentionPrefixes(body, formattedBody) {
    // Extract display names from Matrix mention pill links
    const mentionRe = /<a\s+href="https:\/\/matrix\.to\/#\/@[^"]+">([^<]+)<\/a>/gi;
    let match;
    const displayNames = [];
    while ((match = mentionRe.exec(formattedBody)) !== null) {
        displayNames.push(match[1]);
    }
    if (displayNames.length === 0)
        return body;
    let result = body;
    for (const name of displayNames) {
        // Only prefix if the name appears without @ already
        // Use word boundary to avoid partial replacements
        const re = new RegExp(`(?<!@)\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
        result = result.replace(re, `@${name}`);
    }
    return result;
}
function toJid(roomId) {
    return `matrix:${roomId}`;
}
function toRoomId(jid) {
    return jid.slice('matrix:'.length);
}
function escapeHtml(input) {
    return input
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
function isEscaped(text, index) {
    let slashCount = 0;
    let i = index - 1;
    while (i >= 0 && text[i] === '\\') {
        slashCount++;
        i--;
    }
    return slashCount % 2 === 1;
}
function findClosingSingleDollar(text, from) {
    for (let i = from; i < text.length; i++) {
        if (text[i] !== '$')
            continue;
        if (isEscaped(text, i))
            continue;
        if (text[i - 1] === '$' || text[i + 1] === '$')
            continue;
        return i;
    }
    return -1;
}
function findClosingDoubleDollar(text, from) {
    for (let i = from; i < text.length - 1; i++) {
        if (text[i] !== '$' || text[i + 1] !== '$')
            continue;
        if (isEscaped(text, i))
            continue;
        return i;
    }
    return -1;
}
function sanitizeHref(url) {
    const trimmed = url.trim();
    if (/^(https?:\/\/|mailto:|file:\/\/)/i.test(trimmed)) {
        return escapeHtml(trimmed);
    }
    return null;
}
function normalizeSenderPrefixForMarkdown(text) {
    const match = text.match(/^([^\n:]{1,160}):\s+([\s\S]+)$/);
    if (!match)
        return text;
    const sender = match[1].trim();
    const body = match[2];
    if (!sender || !body)
        return text;
    return `${sender}: \n\n${body}`;
}
export function toFormattedBodyWithMarkdownAndMath(text) {
    const tokens = [];
    const placeholder = (html) => {
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
        if (working[i] === '$' &&
            working[i + 1] === '$' &&
            !isEscaped(working, i)) {
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
        if (working[i] === '$' &&
            working[i + 1] !== '$' &&
            !isEscaped(working, i)) {
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
    const formattedBody = working.replace(/@@MATRIX_TOKEN_(\d+)@@/g, (_m, idxText) => tokens[Number(idxText)] ?? '');
    return { formattedBody, hasRichFormatting };
}
function defaultExtensionForMime(mimetype) {
    const map = {
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
function inferImageDimensions(buffer) {
    if (buffer.length >= 24 && buffer.slice(0, 8).equals(Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]))) {
        const width = buffer.readUInt32BE(16);
        const height = buffer.readUInt32BE(20);
        if (width > 0 && height > 0)
            return { width, height };
    }
    if (buffer.length >= 10 &&
        buffer.slice(0, 3).toString('ascii') === 'GIF') {
        const width = buffer.readUInt16LE(6);
        const height = buffer.readUInt16LE(8);
        if (width > 0 && height > 0)
            return { width, height };
    }
    if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
        let offset = 2;
        while (offset + 9 < buffer.length) {
            if (buffer[offset] !== 0xff) {
                offset++;
                continue;
            }
            const marker = buffer[offset + 1];
            if (marker === 0xc0 ||
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
                marker === 0xcf) {
                const height = buffer.readUInt16BE(offset + 5);
                const width = buffer.readUInt16BE(offset + 7);
                if (width > 0 && height > 0)
                    return { width, height };
                return null;
            }
            if (marker === 0xd8 || marker === 0xd9) {
                offset += 2;
                continue;
            }
            const segmentLength = buffer.readUInt16BE(offset + 2);
            if (segmentLength < 2)
                break;
            offset += 2 + segmentLength;
        }
    }
    return null;
}
function matrixErrCode(err) {
    if (!err || typeof err !== 'object')
        return undefined;
    const record = err;
    if (typeof record.errcode === 'string')
        return record.errcode;
    if (record.body && typeof record.body === 'object') {
        const body = record.body;
        if (typeof body.errcode === 'string')
            return body.errcode;
    }
    return undefined;
}
export class MatrixChannel {
    name = 'matrix';
    prefixAssistantName = false; // Bot display name shows in Matrix
    client = null;
    _connected = false;
    botUserId = MATRIX_USER_ID;
    opts;
    lastMessageEventId = new Map();
    recentBotEventIds = new Map();
    senderNameCache = new Map(); // userId → displayname
    roomNameCache = new Map(); // roomId → display name
    // Sequential send queue — prevents concurrent Matrix API calls from racing.
    // No rate limit handling needed: private homeserver (Continuwuity) has no rate limits.
    _sendQueue = [];
    _sendQueueRunning = false;
    constructor(opts) {
        this.opts = opts;
        configureMatrixSdkLogger();
    }
    /** Track the last N bot-sent event IDs per room for reaction matching. */
    trackBotEvent(roomId, eventId, maxHistory = 10) {
        const ids = this.recentBotEventIds.get(roomId) ?? [];
        ids.push(eventId);
        if (ids.length > maxHistory)
            ids.splice(0, ids.length - maxHistory);
        this.recentBotEventIds.set(roomId, ids);
    }
    /**
     * Queue a Matrix API call for sequential execution.
     * Prevents concurrent sends from racing — no rate limit handling needed
     * since the private homeserver (Continuwuity) has no rate limits.
     */
    enqueueSend(fn) {
        return new Promise((resolve, reject) => {
            this._sendQueue.push(async () => {
                try {
                    resolve(await fn());
                }
                catch (err) {
                    reject(err);
                }
            });
            void this.drainSendQueue();
        });
    }
    async drainSendQueue() {
        if (this._sendQueueRunning)
            return;
        this._sendQueueRunning = true;
        while (this._sendQueue.length > 0) {
            const task = this._sendQueue.shift();
            await task();
        }
        this._sendQueueRunning = false;
    }
    readStored(storage, key) {
        const v = storage.readValue(key);
        return typeof v === 'string' && v.trim().length > 0 ? v : undefined;
    }
    storeTokens(storage, data) {
        if (data.access_token)
            storage.storeValue(STORAGE_ACCESS_TOKEN, data.access_token);
        if (data.refresh_token)
            storage.storeValue(STORAGE_REFRESH_TOKEN, data.refresh_token);
        if (data.device_id)
            storage.storeValue(STORAGE_DEVICE_ID, data.device_id);
        if (data.user_id)
            storage.storeValue(STORAGE_USER_ID, data.user_id);
    }
    async postMatrixJson(path, body) {
        const url = `${MATRIX_HOMESERVER}${path}`;
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        });
        const text = await res.text();
        let parsed = {};
        try {
            parsed = text ? JSON.parse(text) : {};
        }
        catch {
            parsed = { error: text || `${res.status} ${res.statusText}` };
        }
        if (!res.ok) {
            const record = parsed && typeof parsed === 'object'
                ? parsed
                : {};
            const err = new Error(typeof record.error === 'string'
                ? record.error
                : `${res.status} ${res.statusText}`);
            err.statusCode = res.status;
            err.body = record;
            if (typeof record.errcode === 'string')
                err.errcode = record.errcode;
            if (typeof record.error === 'string')
                err.error = record.error;
            throw err;
        }
        return parsed;
    }
    async refreshAccessToken(refreshToken) {
        return await this.postMatrixJson('/_matrix/client/v3/refresh', {
            refresh_token: refreshToken,
        });
    }
    async passwordLoginWithRefresh(username, password, deviceId) {
        const payload = {
            type: 'm.login.password',
            identifier: {
                type: 'm.id.user',
                user: username,
            },
            password,
            initial_device_display_name: MATRIX_DEVICE_NAME,
            refresh_token: true,
        };
        if (deviceId)
            payload.device_id = deviceId;
        return await this.postMatrixJson('/_matrix/client/v3/login', payload);
    }
    isAuthFailure(err) {
        const code = matrixErrCode(err);
        return code === 'M_UNKNOWN_TOKEN' || code === 'M_FORBIDDEN';
    }
    isTooLargeError(err) {
        return matrixErrCode(err) === 'M_TOO_LARGE';
    }
    markDisconnected(context, err) {
        this._connected = false;
        if (err) {
            logger.warn({ errcode: matrixErrCode(err), err }, context);
        }
        else {
            logger.warn(context);
        }
        try {
            this.client?.stop();
        }
        catch {
            // Best-effort cleanup
        }
        this.client = null;
    }
    async createAuthedClient(storage) {
        const storedAccessToken = this.readStored(storage, STORAGE_ACCESS_TOKEN);
        const storedRefreshToken = this.readStored(storage, STORAGE_REFRESH_TOKEN);
        const storedDeviceId = this.readStored(storage, STORAGE_DEVICE_ID);
        const hasAccessToken = !!MATRIX_ACCESS_TOKEN || !!storedAccessToken;
        const hasPasswordLogin = !!MATRIX_USERNAME && !!MATRIX_PASSWORD;
        if (!MATRIX_HOMESERVER ||
            (!hasAccessToken && !hasPasswordLogin && !storedRefreshToken)) {
            return null;
        }
        const validate = async (client, source) => {
            const whoami = await withTimeout(client.getWhoAmI(), MATRIX_HEALTH_TIMEOUT_MS, 'getWhoAmI');
            this.botUserId = whoami.user_id || MATRIX_USER_ID;
            storage.storeValue(STORAGE_USER_ID, this.botUserId);
            logger.info({ source, userId: this.botUserId }, 'Matrix auth validated');
            return client;
        };
        if (MATRIX_ACCESS_TOKEN) {
            const tokenClient = new MatrixClient(MATRIX_HOMESERVER, MATRIX_ACCESS_TOKEN, storage);
            try {
                storage.storeValue(STORAGE_ACCESS_TOKEN, MATRIX_ACCESS_TOKEN);
                return await validate(tokenClient, 'access_token');
            }
            catch (err) {
                logger.warn({ errcode: matrixErrCode(err), err }, 'Matrix access token rejected');
            }
        }
        if (storedAccessToken) {
            const tokenClient = new MatrixClient(MATRIX_HOMESERVER, storedAccessToken, storage);
            try {
                return await validate(tokenClient, 'stored_access_token');
            }
            catch (err) {
                logger.warn({ errcode: matrixErrCode(err), err }, 'Stored Matrix access token rejected');
            }
        }
        if (storedRefreshToken) {
            try {
                const refreshed = await this.refreshAccessToken(storedRefreshToken);
                if (!refreshed.access_token) {
                    throw new Error('refresh endpoint returned no access_token');
                }
                this.storeTokens(storage, refreshed);
                const refreshClient = new MatrixClient(MATRIX_HOMESERVER, refreshed.access_token, storage);
                return await validate(refreshClient, 'refresh_token');
            }
            catch (err) {
                logger.warn({ errcode: matrixErrCode(err), err }, 'Matrix refresh token flow failed');
            }
        }
        if (hasPasswordLogin) {
            try {
                const login = await this.passwordLoginWithRefresh(MATRIX_USERNAME, MATRIX_PASSWORD, storedDeviceId);
                if (!login.access_token) {
                    throw new Error('password login returned no access_token');
                }
                this.storeTokens(storage, login);
                const passwordClient = new MatrixClient(MATRIX_HOMESERVER, login.access_token, storage);
                return await validate(passwordClient, 'password_login');
            }
            catch (err) {
                logger.warn({ errcode: matrixErrCode(err), err }, 'Password login with refresh failed, falling back to MatrixAuth');
            }
            const auth = new MatrixAuth(MATRIX_HOMESERVER);
            const loggedIn = await auth.passwordLogin(MATRIX_USERNAME, MATRIX_PASSWORD, MATRIX_DEVICE_NAME);
            const passwordClient = new MatrixClient(MATRIX_HOMESERVER, loggedIn.accessToken, storage);
            return await validate(passwordClient, 'password_login');
        }
        logger.error({
            hasEnvAccessToken: !!MATRIX_ACCESS_TOKEN,
            hasStoredAccessToken: !!storedAccessToken,
            hasStoredRefreshToken: !!storedRefreshToken,
            hasPasswordLogin,
        }, 'Matrix auth failed: no valid token/login available');
        return null;
    }
    async connect() {
        if (this._connected)
            return;
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
        client.on('room.invite', async (roomId) => {
            try {
                await client.joinRoom(roomId);
                logger.info({ roomId }, 'Auto-joined Matrix room');
            }
            catch (err) {
                logger.warn({ roomId, err }, 'Failed to auto-join Matrix room');
            }
        });
        // Listen for reactions (m.reaction events)
        client.on('room.event', async (roomId, event) => {
            if (event.type !== 'm.reaction')
                return;
            if (event.sender === this.botUserId)
                return;
            const content = event.content;
            const relatesTo = content?.['m.relates_to'];
            const emoji = relatesTo?.key;
            const reactedToId = relatesTo?.event_id;
            if (!emoji || !reactedToId)
                return;
            const matrixJid = toJid(roomId);
            const groups = this.opts.registeredGroups();
            if (!groups[matrixJid])
                return;
            // Only deliver reactions to the bot's own recent messages to avoid flooding
            const recentBotEvents = this.recentBotEventIds.get(roomId) ?? [];
            if (!recentBotEvents.includes(reactedToId))
                return;
            const timestamp = new Date(event.origin_server_ts).toISOString();
            const senderName = await this.getSenderName(event.sender);
            const msg = {
                id: `reaction-${event.event_id}`,
                chat_jid: matrixJid,
                sender: event.sender,
                sender_name: senderName,
                content: `[reaction: ${emoji} to message ${reactedToId}]`,
                timestamp,
            };
            logger.debug({ matrixJid, emoji, reactedToId }, 'Matrix reaction delivered to onMessage');
            this.opts.onMessage(matrixJid, msg);
        });
        // Listen for messages
        client.on('room.message', async (roomId, event) => {
            if (event.event_id && typeof event.event_id === 'string') {
                this.lastMessageEventId.set(roomId, event.event_id);
            }
            logger.debug({ roomId, sender: event.sender }, 'Matrix room.message event');
            if (!event.content)
                return;
            const content = event.content;
            const msgtype = content.msgtype;
            if (msgtype !== 'm.text' && !MEDIA_MSGTYPES.includes(msgtype))
                return;
            // Ignore own messages
            if (event.sender === this.botUserId)
                return;
            const matrixJid = toJid(roomId);
            const timestamp = new Date(event.origin_server_ts).toISOString();
            const senderName = await this.getSenderName(event.sender);
            // Notify metadata for room discovery
            const roomName = await this.getRoomName(roomId);
            this.opts.onChatMetadata(matrixJid, timestamp, roomName);
            // Only deliver full messages for registered rooms (but ! commands bypass)
            const groups = this.opts.registeredGroups();
            const body = msgtype === 'm.text' ? (content.body || '') : '';
            if (!groups[matrixJid] && !body.startsWith('!')) {
                logger.debug({ matrixJid, registeredJids: Object.keys(groups) }, 'Matrix message from unregistered room');
                return;
            }
            // Extract thread ID from m.relates_to (MSC3440)
            const relatesTo = content['m.relates_to'];
            // Ignore edit events (m.replace) — these are status indicator updates, not new messages
            if (relatesTo?.rel_type === 'm.replace')
                return;
            const threadId = relatesTo?.rel_type === 'm.thread' ? relatesTo.event_id : undefined;
            let messageContent;
            if (msgtype === 'm.text') {
                messageContent = content.body;
                // Matrix mention pills strip the @ prefix from display names in body.
                // Restore it using formatted_body so trigger patterns can match @Name.
                const formattedBody = content.formatted_body;
                if (formattedBody) {
                    messageContent = restoreMentionPrefixes(messageContent, formattedBody);
                }
            }
            else {
                // Media message — download and save to IPC media dir
                const group = groups[matrixJid];
                const filename = content.body || 'attachment';
                const mxcUrl = content.url;
                const mediaLabel = msgtype === 'm.image' ? 'image' : msgtype === 'm.video' ? 'video' : msgtype === 'm.audio' ? 'audio' : 'file';
                if (mxcUrl) {
                    const containerPath = await this.downloadMedia(mxcUrl, filename, group.folder);
                    if (containerPath) {
                        messageContent = `[Uploaded ${mediaLabel}: ${filename} — saved to ${containerPath}]`;
                    }
                    else {
                        messageContent = `[Uploaded ${mediaLabel}: ${filename} — download failed]`;
                    }
                }
                else {
                    messageContent = `[Uploaded ${mediaLabel}: ${filename} — no download URL]`;
                }
                // Some clients include a caption in formatted_body distinct from the filename
                const bodyText = content.body;
                const filenameField = content.filename;
                if (bodyText && filenameField && bodyText !== filenameField) {
                    messageContent += `\nCaption: ${bodyText}`;
                }
            }
            const msg = {
                id: event.event_id,
                chat_jid: matrixJid,
                sender: event.sender,
                sender_name: senderName,
                content: messageContent,
                timestamp,
                thread_id: threadId,
            };
            logger.debug({ matrixJid, content: messageContent }, 'Matrix message delivered to onMessage');
            this.opts.onMessage(matrixJid, msg);
        });
        // Reduce sync traffic: don't send/receive presence updates
        client.syncingPresence = 'offline';
        try {
            await withTimeout(client.start(), MATRIX_CONNECT_TIMEOUT_MS, 'client.start');
            this._connected = true;
            logger.info('Connected to Matrix');
            if (this.opts.displayName) {
                client.setDisplayName(this.opts.displayName).catch((err) => {
                    logger.warn({ err }, 'Failed to set display name');
                });
            }
        }
        catch (err) {
            this.markDisconnected('Failed to connect to Matrix', err);
            throw err;
        }
    }
    /** Update the bot's Matrix display name (e.g. for CO badge changes). */
    async setDisplayName(name) {
        if (!this.client || !this._connected)
            return;
        try {
            await this.client.setDisplayName(name);
        }
        catch (err) {
            logger.warn({ err, name }, 'Failed to update display name');
        }
    }
    async sendTextReturningId(jid, text, threadId) {
        if (!this.client || !this._connected)
            return undefined;
        const roomId = toRoomId(jid);
        if (threadId) {
            logger.info({ roomId, threadId }, 'Matrix sendMessage with thread');
        }
        const normalizedText = normalizeSenderPrefixForMarkdown(text);
        // If text STARTS with an HTML tag, treat it as preformatted HTML and skip markdown.
        // This covers: <details> tool call blocks, <font> status messages, <small> headers.
        // We do NOT match HTML anywhere in the text — markdown content may contain inline HTML
        // (e.g. delegate headers) and marked handles that fine.
        const isPreformattedHtml = /^<[a-z]/i.test(text.trimStart());
        let html;
        if (isPreformattedHtml) {
            html = text;
        }
        else {
            // Strategy: Extract math to protect it, apply markdown, then restore math
            const mathTokens = [];
            const mathPlaceholder = (htmlStr) => {
                const idx = mathTokens.push(htmlStr) - 1;
                return `@@MATH_${idx}@@`;
            };
            // Extract inline and display math before markdown processing
            let working = normalizedText;
            working = working.replace(/\$\$([^\$]+)\$\$/g, (_m, latex) => {
                return mathPlaceholder(`<div data-mx-maths="${escapeHtml(latex.trim())}"><code>${escapeHtml(latex.trim())}</code></div>`);
            });
            working = working.replace(/\$([^\$\n]+)\$/g, (_m, latex) => {
                return mathPlaceholder(`<span data-mx-maths="${escapeHtml(latex.trim())}"><code>${escapeHtml(latex.trim())}</code></span>`);
            });
            // Apply markdown with custom renderer to strip <p> tags inside list items
            // (marked generates "loose" lists with <p> when items are separated by blank lines)
            const renderer = new marked.Renderer();
            const origListitem = renderer.listitem.bind(renderer);
            renderer.listitem = (item) => {
                const result = origListitem(item);
                return result.replace(/<p>([\s\S]*?)<\/p>/g, '$1');
            };
            html = await marked(working, { breaks: true, gfm: true, renderer });
            // Restore math placeholders
            html = html.replace(/@@MATH_(\d+)@@/g, (_m, idxText) => mathTokens[Number(idxText)] ?? '');
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const msgContent = {
            msgtype: 'm.text',
            body: normalizedText,
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
            const eventId = await withTimeout(this.client.sendMessage(roomId, msgContent), MATRIX_SEND_TIMEOUT_MS, 'sendMessage');
            if (eventId)
                this.trackBotEvent(roomId, eventId);
            return eventId;
        });
    }
    async sendMessage(jid, text, threadId) {
        try {
            await this.sendTextReturningId(jid, text, threadId);
        }
        catch (err) {
            if (this.isTooLargeError(err) && text.length > 2000) {
                // Truncate and retry once for oversized messages
                const truncated = text.slice(0, 16_000) + '\n\n…(truncated — message too large for Matrix)';
                logger.warn({ jid, originalLen: text.length }, 'Message too large, retrying truncated');
                try {
                    await this.sendTextReturningId(jid, truncated, threadId);
                    return;
                }
                catch (retryErr) {
                    logger.warn({ jid, retryErr }, 'Truncated message retry also failed');
                }
            }
            if (this.isAuthFailure(err)) {
                this.markDisconnected('Matrix auth failed while sending message', err);
            }
            logger.warn({ jid, err }, 'Failed to send Matrix message');
        }
    }
    async sendReaction(jid, eventId, emoji) {
        if (!this.client || !this._connected)
            return;
        const roomId = toRoomId(jid);
        try {
            const content = {
                'm.relates_to': {
                    rel_type: 'm.annotation',
                    event_id: eventId,
                    key: emoji,
                },
            };
            await this.enqueueSend(() => withTimeout(this.client.sendEvent(roomId, 'm.reaction', content), MATRIX_SEND_TIMEOUT_MS, 'sendReaction'));
        }
        catch (err) {
            if (this.isAuthFailure(err)) {
                this.markDisconnected('Matrix auth failed while sending reaction', err);
            }
            logger.warn({ jid, eventId, err }, 'Failed to send Matrix reaction');
        }
    }
    async sendMessageReturningId(jid, text, threadId) {
        try {
            return await this.sendTextReturningId(jid, text, threadId);
        }
        catch (err) {
            logger.warn({ jid, err }, 'Failed to send Matrix message (returning id)');
            return undefined;
        }
    }
    async editMessage(jid, eventId, newText) {
        if (!this.client || !this._connected)
            return;
        const roomId = toRoomId(jid);
        try {
            const normalizedEdit = normalizeSenderPrefixForMarkdown(newText);
            const isPreformattedHtml = /^<[a-z]/i.test(newText.trimStart());
            let editHtml;
            if (isPreformattedHtml) {
                editHtml = newText;
            }
            else {
                editHtml = await marked(normalizedEdit, { breaks: true, gfm: true });
                editHtml = editHtml.trim();
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const newContent = {
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
            await this.enqueueSend(() => withTimeout(this.client.sendMessage(roomId, content), MATRIX_SEND_TIMEOUT_MS, 'editMessage'));
        }
        catch (err) {
            if (this.isTooLargeError(err) && newText.length > 2000) {
                const truncated = newText.slice(0, 16_000) + '\n\n…(truncated)';
                try {
                    const truncHtml = truncated.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                    const truncContent = {
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
                    await this.enqueueSend(() => withTimeout(this.client.sendMessage(roomId, truncContent), MATRIX_SEND_TIMEOUT_MS, 'editMessage(truncated)'));
                    return;
                }
                catch (retryErr) {
                    logger.warn({ jid, eventId, retryErr }, 'Truncated edit retry also failed');
                }
            }
            logger.warn({ jid, eventId, err }, 'Failed to edit Matrix message');
        }
    }
    async redactMessage(jid, eventId) {
        if (!this.client || !this._connected)
            return;
        const roomId = toRoomId(jid);
        try {
            await this.enqueueSend(() => withTimeout(this.client.redactEvent(roomId, eventId), MATRIX_SEND_TIMEOUT_MS, 'redactMessage'));
        }
        catch (err) {
            logger.warn({ jid, eventId, err }, 'Failed to redact Matrix message');
        }
    }
    isConnected() {
        return this._connected;
    }
    ownsJid(jid) {
        return jid.startsWith('matrix:');
    }
    async disconnect() {
        this._connected = false;
        try {
            this.client?.stop();
        }
        catch {
            // Best-effort cleanup
        }
        this.client = null;
    }
    async checkHealth() {
        if (!this.client || !this._connected)
            return false;
        try {
            await withTimeout(this.client.getWhoAmI(), MATRIX_HEALTH_TIMEOUT_MS, 'health check getWhoAmI');
            return true;
        }
        catch (err) {
            this.markDisconnected('Matrix health check failed', err);
            return false;
        }
    }
    async sendImage(jid, buffer, filename, mimetype, caption) {
        return this.sendMedia('image', jid, buffer, filename, mimetype, caption);
    }
    async sendFile(jid, buffer, filename, mimetype, caption) {
        return this.sendMedia('file', jid, buffer, filename, mimetype, caption);
    }
    async sendMedia(kind, jid, buffer, filename, mimetype, caption) {
        if (!this.client || !this._connected)
            return;
        const roomId = toRoomId(jid);
        const isImage = kind === 'image';
        const defaultName = isImage ? 'image' : 'attachment';
        const msgtype = isImage ? 'm.image' : 'm.file';
        try {
            logger.info({ filename, mimetype, size: buffer.length }, `Uploading ${kind} to Matrix`);
            const mxcUrl = await this.enqueueSend(() => withTimeout(this.client.uploadContent(buffer, mimetype, filename), MATRIX_UPLOAD_TIMEOUT_MS, `uploadContent(${kind})`));
            logger.info({ mxcUrl, filename }, `${kind} uploaded, sending to room`);
            const effectiveFilename = filename?.trim()
                ? filename.trim()
                : `${defaultName}.${defaultExtensionForMime(mimetype)}`;
            const info = { mimetype, size: buffer.length };
            if (isImage) {
                const dimensions = inferImageDimensions(buffer);
                if (dimensions) {
                    info.w = dimensions.width;
                    info.h = dimensions.height;
                }
                // Compatibility: some Matrix clients rely on thumbnail fields to decide
                // whether an m.image can be previewed inline.
                info.thumbnail_url = mxcUrl;
                const thumbnailInfo = { mimetype, size: buffer.length };
                if (dimensions) {
                    thumbnailInfo.w = dimensions.width;
                    thumbnailInfo.h = dimensions.height;
                }
                info.thumbnail_info = thumbnailInfo;
            }
            const content = {
                msgtype,
                body: effectiveFilename,
                filename: effectiveFilename,
                url: mxcUrl,
                info,
            };
            const eventId = await this.enqueueSend(() => withTimeout(this.client.sendMessage(roomId, content), MATRIX_SEND_TIMEOUT_MS, `sendMessage(${kind})`));
            if (eventId)
                this.trackBotEvent(roomId, eventId);
            if (caption && caption.trim()) {
                await this.sendMessage(jid, caption.trim());
            }
            logger.info({ roomId, filename }, `${kind} message sent`);
        }
        catch (err) {
            if (this.isAuthFailure(err)) {
                this.markDisconnected(`Matrix auth failed while sending ${kind}`, err);
            }
            logger.warn({ jid, filename, err }, `Failed to send Matrix ${kind}`);
        }
    }
    async setPresenceStatus(state, statusMessage) {
        if (!this.client || !this._connected)
            return;
        try {
            await this.client.setPresenceStatus(state, statusMessage);
        }
        catch {
            // Non-critical
        }
    }
    async setStatusPip(_jid, _emoji) {
        // Pip reactions disabled
    }
    async setTyping(jid, isTyping) {
        if (!this.client || !this._connected)
            return;
        const roomId = toRoomId(jid);
        try {
            await withTimeout(this.client.setTyping(roomId, isTyping, 30000), MATRIX_TYPING_TIMEOUT_MS, 'setTyping');
        }
        catch {
            // Non-critical
        }
    }
    async downloadMedia(mxcUrl, filename, groupFolder) {
        if (!this.client)
            return null;
        try {
            const { data, contentType } = await withTimeout(this.client.downloadContent(mxcUrl), 30_000, 'downloadContent');
            if (data.length > MEDIA_MAX_BYTES) {
                logger.warn({ filename, size: data.length, limit: MEDIA_MAX_BYTES }, 'Media file too large, skipping download');
                return null;
            }
            // Sanitize filename: strip path separators, limit length
            const sanitized = filename.replace(/[/\\]/g, '_').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
            const timestamped = `${Date.now()}-${sanitized}`;
            const mediaDir = path.join(DATA_DIR, 'ipc', groupFolder, 'media');
            fs.mkdirSync(mediaDir, { recursive: true });
            const hostPath = path.join(mediaDir, timestamped);
            fs.writeFileSync(hostPath, data);
            const containerPath = `/workspace/ipc/${groupFolder}/media/${timestamped}`;
            logger.info({ filename, contentType, size: data.length, containerPath }, 'Media downloaded to IPC');
            return containerPath;
        }
        catch (err) {
            logger.warn({ mxcUrl, filename, err }, 'Failed to download media from Matrix');
            return null;
        }
    }
    async getSenderName(userId) {
        const cached = this.senderNameCache.get(userId);
        if (cached)
            return cached;
        if (!this.client)
            return userId;
        try {
            const profile = await withTimeout(this.client.getUserProfile(userId), MATRIX_META_TIMEOUT_MS, 'getUserProfile');
            const name = profile.displayname || userId.split(':')[0].slice(1);
            if (this.senderNameCache.size >= 500)
                this.senderNameCache.clear();
            this.senderNameCache.set(userId, name);
            return name;
        }
        catch {
            return userId.split(':')[0].slice(1);
        }
    }
    async getRoomName(roomId) {
        const cached = this.roomNameCache.get(roomId);
        if (cached)
            return cached;
        if (!this.client)
            return roomId;
        try {
            const state = await withTimeout(this.client.getRoomStateEvent(roomId, 'm.room.name', ''), MATRIX_META_TIMEOUT_MS, 'getRoomStateEvent(m.room.name)');
            const name = state.name || roomId;
            if (this.roomNameCache.size >= 200)
                this.roomNameCache.clear();
            this.roomNameCache.set(roomId, name);
            return name;
        }
        catch {
            return roomId;
        }
    }
}
//# sourceMappingURL=matrix.js.map