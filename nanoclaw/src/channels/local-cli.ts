import readline from 'readline';

import {
  LOCAL_CHAT_JID,
  LOCAL_CHAT_NAME,
  LOCAL_CHAT_SENDER_NAME,
} from '../config.js';
import { logger } from '../logger.js';
import { Channel, NewMessage, OnChatMetadata, OnInboundMessage } from '../types.js';

export interface LocalCliChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  mirrorToMatrix?: (text: string) => Promise<void>;
}

export class LocalCliChannel implements Channel {
  name = 'local-cli';
  private connected = false;
  private rl: readline.Interface | null = null;
  private msgSeq = 0;
  private readonly senderName = LOCAL_CHAT_SENDER_NAME.trim();
  private readonly senderId = LOCAL_CHAT_SENDER_NAME.trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');

  constructor(private readonly opts: LocalCliChannelOpts) {}

  async connect(): Promise<void> {
    if (this.connected) return;
    if (!this.senderName || !this.senderId) {
      throw new Error(
        'LOCAL_CHAT_SENDER_NAME is required for local terminal channel',
      );
    }

    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });

    this.connected = true;
    this.opts.onChatMetadata(LOCAL_CHAT_JID, new Date().toISOString(), LOCAL_CHAT_NAME);

    process.stdout.write(
      '\n[local-cli] Connected. Type messages and press Enter. Use /quit to exit.\n\n',
    );

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
      const msg: NewMessage = {
        id: `local-${Date.now()}-${this.msgSeq++}`,
        chat_jid: LOCAL_CHAT_JID,
        chat_name: LOCAL_CHAT_NAME,
        sender: this.senderId,
        sender_name: this.senderName,
        content: text,
        timestamp: now,
      };
      this.opts.onMessage(LOCAL_CHAT_JID, msg);
      if (this.opts.mirrorToMatrix) {
        this.opts.mirrorToMatrix(`${this.senderName}: ${text}`).catch((err) => {
          logger.warn({ err }, 'Failed mirroring local inbound message to Matrix');
        });
      }
      this.prompt();
    });

    this.prompt();
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.ownsJid(jid)) return;
    process.stdout.write(`\n${text}\n\n`);
    if (this.opts.mirrorToMatrix) {
      this.opts.mirrorToMatrix(`Terminal(Bot): ${text}`).catch((err) => {
        logger.warn({ err }, 'Failed mirroring local outbound message to Matrix');
      });
    }
    this.prompt();
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.ownsJid(jid)) return;
    if (isTyping) {
      process.stdout.write('\n[cid typing...]\n');
      this.prompt();
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid === LOCAL_CHAT_JID;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
  }

  private prompt(): void {
    if (!this.rl || !this.connected) return;
    this.rl.setPrompt(`${this.senderName.toLowerCase()}> `);
    this.rl.prompt();
  }
}
