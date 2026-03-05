import readline from 'readline';
import { LOCAL_CHAT_JID, LOCAL_CHAT_NAME, LOCAL_CHAT_SENDER_NAME, } from '../infini-config.js';
import { logger } from 'nanoclaw/logger.js';
export class LocalCliChannel {
    opts;
    name = 'local-cli';
    connected = false;
    rl = null;
    msgSeq = 0;
    senderName = LOCAL_CHAT_SENDER_NAME.trim();
    senderId = LOCAL_CHAT_SENDER_NAME.trim()
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '');
    constructor(opts) {
        this.opts = opts;
    }
    formatMirrorInbound(text) {
        return `\`\`\`\n${this.senderName}: ${text}\n\`\`\``;
    }
    formatMirrorOutbound(text) {
        return text;
    }
    async connect() {
        if (this.connected)
            return;
        if (!this.senderName || !this.senderId) {
            throw new Error('LOCAL_CHAT_SENDER_NAME is required for local terminal channel');
        }
        this.rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
            terminal: true,
        });
        this.connected = true;
        this.opts.onChatMetadata(LOCAL_CHAT_JID, new Date().toISOString(), LOCAL_CHAT_NAME);
        process.stdout.write('\n[local-cli] Connected. Type messages and press Enter. Use /quit to exit.\n\n');
        this.rl.on('line', (line) => {
            const text = line.trim();
            if (!text) {
                this.prompt();
                return;
            }
            if (text === '/quit' || text === '/exit') {
                process.stdout.write('[local-cli] Exiting...\n');
                process.exit(0);
            }
            const now = new Date().toISOString();
            const msg = {
                id: `local-${Date.now()}-${this.msgSeq++}`,
                chat_jid: LOCAL_CHAT_JID,
                sender: this.senderId,
                sender_name: this.senderName,
                content: text,
                timestamp: now,
            };
            this.opts.onMessage(LOCAL_CHAT_JID, msg);
            if (this.opts.mirrorToMatrix) {
                this.opts
                    .mirrorToMatrix(this.formatMirrorInbound(text))
                    .catch((err) => {
                    logger.warn({ err }, 'Failed mirroring local inbound message to Matrix');
                });
            }
            this.prompt();
        });
        this.prompt();
    }
    async sendMessage(jid, text) {
        if (!this.ownsJid(jid))
            return;
        process.stdout.write(`\n${text}\n\n`);
        if (this.opts.mirrorToMatrix) {
            this.opts
                .mirrorToMatrix(this.formatMirrorOutbound(text))
                .catch((err) => {
                logger.warn({ err }, 'Failed mirroring local outbound message to Matrix');
            });
        }
        this.prompt();
    }
    async setPresenceStatus(_state, statusMessage) {
        if (statusMessage)
            process.stdout.write(`\n[${statusMessage}]\n`);
    }
    async setTyping(jid, isTyping) {
        if (!this.ownsJid(jid))
            return;
        if (isTyping) {
            process.stdout.write('\n[typing...]\n');
            this.prompt();
        }
    }
    isConnected() {
        return this.connected;
    }
    ownsJid(jid) {
        return jid === LOCAL_CHAT_JID;
    }
    async disconnect() {
        this.connected = false;
        if (this.rl) {
            this.rl.close();
            this.rl = null;
        }
    }
    prompt() {
        if (!this.rl || !this.connected)
            return;
        this.rl.setPrompt(`${this.senderName.toLowerCase()}> `);
        this.rl.prompt();
    }
}
//# sourceMappingURL=local-cli.js.map