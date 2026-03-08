import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadFleet, writeFleet, BotEntry, BotStatus } from './ship-config.js';
import { logger } from 'nanoclaw/logger.js';
import { NewMessage } from 'nanoclaw/types.js';

export interface FleetEntry extends BotEntry {
  activeBrainModel?: string;
  quartersRoom?: string;
}

export class FleetManager {
  private liveFleet: Record<string, FleetEntry> = {};
  private fleetDirty = false;
  private roomRoster: Record<string, Map<string, number>> = {};
  private roomCO: Record<string, string | undefined> = {};
  private hostname: string;

  constructor() {
    this.hostname = os.hostname();
    try {
      this.liveFleet = loadFleet() as Record<string, FleetEntry>;
    } catch (err) {
      logger.error({ err }, 'Failed to load fleet config');
    }
  }

  updateBot(bot: string, updates: Partial<FleetEntry>): void {
    if (!this.liveFleet[bot]) return;
    Object.assign(this.liveFleet[bot], updates);
    this.fleetDirty = true;
  }

  persist(): void {
    if (!this.fleetDirty) return;
    try {
      writeFleet(this.liveFleet);
      this.fleetDirty = false;
    } catch (err) {
      logger.error({ err }, 'Failed to persist fleet');
    }
  }

  handleLifecycleMessage(msg: { content: string; chat_jid: string; sender: string }, assistantName: string, botMatrixUserIds: Set<string>): boolean {
    const match = msg.content.match(/^\S+: (\S+) (stopped|started|restarted|reranked)(?:\s+\(rank (\d+)\))?$/);
    if (!match) return false;
    if (!msg.sender.includes('-intercom')) return false;

    const [, botName, action, rankStr] = match;
    const chatJid = msg.chat_jid;

    if (!this.roomRoster[chatJid]) this.roomRoster[chatJid] = new Map();

    if (action === 'stopped') {
      this.roomRoster[chatJid].delete(botName);
    } else if (action === 'started' || action === 'reranked') {
      const rank = rankStr ? parseInt(rankStr, 10) : 99;
      this.roomRoster[chatJid].set(botName, rank);
    }

    this.rerankCO(chatJid, assistantName);
    return false;
  }

  private rerankCO(chatJid: string, assistantName: string): void {
    const roster = this.roomRoster[chatJid];
    if (!roster || roster.size === 0) { this.roomCO[chatJid] = undefined; return; }

    let coBotName: string | undefined;
    let coRank = Infinity;
    for (const [name, rank] of roster) {
      if (rank < coRank) { coBotName = name; coRank = rank; }
    }

    this.roomCO[chatJid] = coBotName;
    if (coBotName === assistantName) {
      process.env.IS_CO = 'true';
    } else {
      process.env.IS_CO = '';
    }
  }

  isCO(chatJid: string, assistantName: string): boolean {
    return this.roomCO[chatJid] === assistantName;
  }

  isCOMainTimelineTrigger(chatJid: string, messages: NewMessage[], assistantName: string, botMatrixUserIds: Set<string>): boolean {
    if (this.roomCO[chatJid] !== assistantName) return false;
    const roster = this.roomRoster[chatJid];
    const botNamePatterns: RegExp[] = [];
    if (roster) {
      for (const name of roster.keys()) {
        botNamePatterns.push(new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'));
      }
    }
    return messages.some(m => {
      if (botMatrixUserIds.has(m.sender)) return false;
      if (m.thread_id) return false;
      const content = m.content.trim();
      return !botNamePatterns.some(p => p.test(content));
    });
  }

  rankSwap<T extends { rank: number }>(
    entries: [string, T][],
    target: string,
    direction: 'up' | 'down',
  ): { target: string; swap: string; targetRank: number; swapRank: number } | null {
    const sorted = [...entries].sort((a, b) => a[1].rank - b[1].rank);
    const idx = sorted.findIndex(([name]) => name === target);
    if (idx < 0) return null;
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= sorted.length) return null;
    const oldRank = sorted[idx][1].rank;
    sorted[idx][1].rank = sorted[swapIdx][1].rank;
    sorted[swapIdx][1].rank = oldRank;
    return { target, swap: sorted[swapIdx][0], targetRank: sorted[idx][1].rank, swapRank: sorted[swapIdx][1].rank };
  }

  getLiveFleet(): Record<string, FleetEntry> {
    return this.liveFleet;
  }

  determineInitialCO(registeredGroups: Record<string, any>, assistantName: string): { initialBadge: string; roomRoster: Record<string, Map<string, number>>; roomCO: Record<string, string | undefined> } {
    const roomRoster: Record<string, Map<string, number>> = {};
    const roomCO: Record<string, string | undefined> = {};
    let initialBadge = '🟢';
    try {
      const fleet = loadFleet();
      const root = resolveRoot();
      const roomNameToJid: Record<string, string> = {};
      for (const [jid, group] of Object.entries(registeredGroups)) {
        roomNameToJid[group.name.toLowerCase()] = jid;
      }
      for (const [botId, entry] of Object.entries(fleet)) {
        if (entry.status !== 'onduty') continue;
        const env = (() => { try { return loadProfileEnv(root, botId); } catch { return null; } })();
        const room = (env?.MAIN_GROUP_NAME || '').toLowerCase();
        const jid = roomNameToJid[room];
        if (!jid) continue;
        const name = env?.ASSISTANT_NAME || botId;
        if (!roomRoster[jid]) roomRoster[jid] = new Map();
        roomRoster[jid].set(name, entry.rank ?? 99);
      }
      for (const [jid, roster] of Object.entries(roomRoster)) {
        let coBotName: string | undefined;
        let coRank = Infinity;
        for (const [name, rank] of roster) {
          if (rank < coRank) { coBotName = name; coRank = rank; }
        }
        roomCO[jid] = coBotName;
        if (coBotName === assistantName) {
          initialBadge = '⭐';
          process.env.IS_CO = 'true';
        }
      }
    } catch { }
    this.roomRoster = roomRoster;
    this.roomCO = roomCO;
    return { initialBadge, roomRoster, roomCO };
  }
}

export const fleetManager = new FleetManager();
