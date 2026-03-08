import { MatrixChannel } from './channels/matrix.js';
import { logger } from 'nanoclaw/logger.js';
import { NewMessage } from 'nanoclaw/types.js';

export class MatrixService {
  private matrixRef: MatrixChannel | null = null;

  setMatrix(matrix: MatrixChannel) {
    this.matrixRef = matrix;
  }

  async setDisplayName(name: string) {
    if (!this.matrixRef) return;
    try {
      await this.matrixRef.setDisplayName(name);
    } catch (err) {
      logger.error({ err }, 'Failed to set display name');
    }
  }

  async sendReaction(chatJid: string, messageId: string, reaction: string) {
    if (!this.matrixRef) return;
    try {
      await this.matrixRef.sendReaction(chatJid, messageId, reaction);
    } catch (err) {
      logger.debug({ chatJid, messageId, err }, 'Failed to send reaction');
    }
  }

  async setTyping(chatJid: string, typing: boolean) {
    if (!this.matrixRef || !this.matrixRef.setTyping) return;
    try {
      await this.matrixRef.setTyping(chatJid, typing);
    } catch (err) {
      logger.debug({ chatJid, err }, 'Failed to set typing');
    }
  }
}

export const matrixService = new MatrixService();
