/**
 * Runtime patches for nanoclaw classes.
 *
 * Import this module early (before using patched functionality) to
 * install InfiniClaw extensions on nanoclaw prototypes. The matching
 * type declarations live in nanoclaw-ext.d.ts.
 */
import fs from 'fs';
import path from 'path';
import { GroupQueue } from 'nanoclaw/group-queue.js';
import { DATA_DIR } from 'nanoclaw/config.js';

// GroupQueue.getGroupStatus — exposes internal group state for status reporting.
// Upstream keeps GroupState private; we access it via JS runtime reflection.
(GroupQueue.prototype as any).getGroupStatus = function (
  this: any,
  groupJid: string,
) {
  const state = this.groups?.get(groupJid);
  return {
    active: state?.active ?? false,
    hasProcess: !!state?.process,
    containerName: state?.containerName ?? null,
    pendingMessages: state?.pendingMessages ?? false,
    pendingTasks: state?.pendingTasks?.length ?? 0,
    idleWaiting: state?.idleWaiting ?? false,
  };
};

// GroupQueue.getActiveGroupJids — list all group JIDs with active containers.
(GroupQueue.prototype as any).getActiveGroupJids = function (this: any) {
  const jids: string[] = [];
  for (const [jid, state] of this.groups?.entries() ?? []) {
    if (state.active) jids.push(jid);
  }
  return jids;
};

// GroupQueue.setPreCloseHook — called before closing stdin on a container.
// Injects a memory-save message file into the IPC input directory.
(GroupQueue.prototype as any)._preCloseHook = null;
(GroupQueue.prototype as any).setPreCloseHook = function (
  this: any,
  fn: (groupJid: string, inputDir: string) => void,
) {
  this._preCloseHook = fn;
};

// GroupQueue.setShutdownHook — called during shutdown for cleanup.
(GroupQueue.prototype as any)._shutdownHook = null;
(GroupQueue.prototype as any).setShutdownHook = function (
  this: any,
  fn: () => Promise<void>,
) {
  this._shutdownHook = fn;
};

// Patch closeStdin to invoke preCloseHook before writing the close sentinel.
const originalCloseStdin = GroupQueue.prototype.closeStdin;
GroupQueue.prototype.closeStdin = function (this: any, groupJid: string) {
  const state = this.groups?.get(groupJid);
  if (state?.groupFolder && this._preCloseHook) {
    const inputDir = path.join(DATA_DIR, 'ipc', state.groupFolder, 'input');
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      this._preCloseHook(groupJid, inputDir);
    } catch {
      // best effort
    }
  }
  return originalCloseStdin.call(this, groupJid);
};

// Patch shutdown to invoke shutdownHook.
const originalShutdown = GroupQueue.prototype.shutdown;
GroupQueue.prototype.shutdown = async function (this: any, gracePeriodMs: number) {
  if (this._shutdownHook) {
    try {
      await this._shutdownHook();
    } catch {
      // best effort
    }
  }
  return originalShutdown.call(this, gracePeriodMs);
};
