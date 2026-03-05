/**
 * InfiniClaw IPC watcher.
 * Polls per-group IPC directories for message and task files.
 * Uses upstream's processTaskIpc for base task types, adds InfiniClaw
 * message types (image, file), delegate threading, and extended commands.
 */
import fs from 'fs';
import path from 'path';
import { processTaskIpc } from 'nanoclaw/ipc.js';
import { DATA_DIR, IPC_POLL_INTERVAL } from 'nanoclaw/config.js';
import { handleInfiniClawCommand, handleInfiniClawMessage, } from './ipc-commands.js';
import { sendViaIntercom } from './intercom-relay.js';
import { logger } from 'nanoclaw/logger.js';
let ipcWatcherRunning = false;
// Per-group delegate thread IDs — created on first delegate message, cleared when set_thread(null) fires
const delegateThreadIds = {};
function clearDelegateThread(sourceGroup) {
    if (sourceGroup in delegateThreadIds) {
        delete delegateThreadIds[sourceGroup];
        logger.debug({ sourceGroup }, 'Delegate thread ID pruned');
    }
}
async function handleTextMessage(data, sourceGroup, isMain, deps) {
    // Cross-room messages go through intercom relay
    if (data.crossRoom && data.senderName) {
        const text = `${data.senderName}: ${data.text}`;
        const sent = await sendViaIntercom(data.chatJid, text);
        if (sent) {
            logger.info({ chatJid: data.chatJid, senderName: data.senderName, sourceGroup }, 'Cross-room message relayed via intercom');
        }
        else {
            logger.error({ chatJid: data.chatJid, sourceGroup }, 'Failed to relay cross-room message via intercom');
        }
        return;
    }
    const registeredGroups = deps.registeredGroups();
    const targetGroup = registeredGroups[data.chatJid];
    const isCrossBotTarget = data.chatJid.startsWith('matrix:');
    const authorized = isMain || (targetGroup && targetGroup.folder === sourceGroup) || isCrossBotTarget;
    if (!authorized) {
        logger.warn({ chatJid: data.chatJid, sourceGroup }, 'Unauthorized IPC message attempt blocked');
        return;
    }
    const explicitThreadId = typeof data.threadId === 'string' ? data.threadId : undefined;
    const body = String(data.text);
    const isDelegateHeader = body.startsWith('💭');
    const threadId = explicitThreadId ?? delegateThreadIds[sourceGroup];
    if (isDelegateHeader && !explicitThreadId) {
        const eventId = await deps.sendMessageReturningId(data.chatJid, body, undefined);
        if (eventId) {
            delegateThreadIds[sourceGroup] = eventId;
            deps.writeLastEventId(sourceGroup, eventId);
            logger.info({ sourceGroup, eventId }, 'Delegate thread created');
        }
    }
    else {
        const eventId = await deps.sendMessageReturningId(data.chatJid, body, threadId);
        if (eventId)
            deps.writeLastEventId(sourceGroup, eventId);
    }
    logger.info({ chatJid: data.chatJid, sourceGroup }, 'IPC message sent');
}
export function startIpcWatcher(deps) {
    if (ipcWatcherRunning) {
        logger.debug('IPC watcher already running, skipping duplicate start');
        return;
    }
    ipcWatcherRunning = true;
    const ipcBaseDir = path.join(DATA_DIR, 'ipc');
    fs.mkdirSync(ipcBaseDir, { recursive: true });
    const processIpcFiles = async () => {
        try {
            await processIpcFilesInner();
        }
        catch (err) {
            logger.error({ err }, 'IPC watcher unexpected error — recovering');
        }
        setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
    };
    const processIpcFilesInner = async () => {
        let groupFolders;
        try {
            groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
                const stat = fs.statSync(path.join(ipcBaseDir, f));
                return stat.isDirectory() && f !== 'errors';
            });
        }
        catch (err) {
            logger.error({ err }, 'Error reading IPC base directory');
            return;
        }
        const registeredGroups = deps.registeredGroups();
        // Build folder→isMain lookup from registered groups
        const folderIsMain = new Map();
        for (const group of Object.values(registeredGroups)) {
            if (group.isMain)
                folderIsMain.set(group.folder, true);
        }
        for (const sourceGroup of groupFolders) {
            const isMain = folderIsMain.get(sourceGroup) === true;
            const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
            const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');
            // Process messages
            try {
                if (fs.existsSync(messagesDir)) {
                    const messageFiles = fs
                        .readdirSync(messagesDir)
                        .filter((f) => f.endsWith('.json'));
                    for (const file of messageFiles) {
                        const filePath = path.join(messagesDir, file);
                        const processingPath = `${filePath}.processing`;
                        const errorPath = `${filePath}.error`;
                        try {
                            fs.renameSync(filePath, processingPath);
                            const data = JSON.parse(fs.readFileSync(processingPath, 'utf-8'));
                            if (data.type === 'message' && data.chatJid && data.text) {
                                await handleTextMessage({
                                    chatJid: data.chatJid,
                                    text: data.text,
                                    sender: data.sender,
                                    threadId: data.threadId,
                                    crossRoom: data.crossRoom,
                                    senderName: data.senderName,
                                }, sourceGroup, isMain, deps);
                            }
                            else {
                                // Extended message types (image, file)
                                const targetGroup = registeredGroups[data.chatJid];
                                const authorized = isMain || !!(targetGroup && targetGroup.folder === sourceGroup);
                                await handleInfiniClawMessage(data, {
                                    authorized,
                                    sourceGroup,
                                    sendImage: deps.sendImage,
                                    sendFile: deps.sendFile,
                                });
                            }
                            fs.unlinkSync(processingPath);
                        }
                        catch (err) {
                            logger.error({ file, sourceGroup, err }, 'Error processing IPC message');
                            try {
                                fs.renameSync(processingPath, errorPath);
                            }
                            catch { /* already gone or couldn't move */ }
                        }
                    }
                }
            }
            catch (err) {
                logger.error({ err, sourceGroup }, 'Error reading IPC messages directory');
            }
            // Process tasks
            try {
                if (fs.existsSync(tasksDir)) {
                    const taskFiles = fs
                        .readdirSync(tasksDir)
                        .filter((f) => f.endsWith('.json'));
                    for (const file of taskFiles) {
                        const filePath = path.join(tasksDir, file);
                        const processingPath = `${filePath}.processing`;
                        const errorPath = `${filePath}.error`;
                        try {
                            fs.renameSync(filePath, processingPath);
                            const data = JSON.parse(fs.readFileSync(processingPath, 'utf-8'));
                            // Try base task types first (schedule, pause, resume, cancel, refresh, register)
                            const baseTypes = ['schedule_task', 'pause_task', 'resume_task', 'cancel_task', 'refresh_groups', 'register_group'];
                            if (baseTypes.includes(data.type)) {
                                await processTaskIpc(data, sourceGroup, isMain, {
                                    sendMessage: (jid, text) => deps.sendMessage(jid, text),
                                    registeredGroups: deps.registeredGroups,
                                    registerGroup: (jid, group) => {
                                        // InfiniClaw extension: replace existing group with same folder
                                        const groups = deps.registeredGroups();
                                        const existing = Object.entries(groups)
                                            .find(([existingJid, g]) => g.folder === data.folder && existingJid !== data.jid);
                                        if (existing) {
                                            deps.unregisterGroup(existing[0]);
                                            logger.info({ oldJid: existing[0], newJid: data.jid, folder: data.folder }, 'Replaced existing group with same folder');
                                        }
                                        deps.registerGroup(jid, group);
                                    },
                                    syncGroups: deps.syncGroups,
                                    getAvailableGroups: deps.getAvailableGroups,
                                    writeGroupsSnapshot: deps.writeGroupsSnapshot,
                                });
                            }
                            else {
                                // Delegate to InfiniClaw extended command handlers
                                const extHandled = await handleInfiniClawCommand(data, {
                                    isMain,
                                    sourceGroup,
                                    sendMessage: deps.sendMessage,
                                    registeredGroups: deps.registeredGroups,
                                    setWorkThread: deps.setWorkThread,
                                    clearDelegateThread,
                                });
                                if (!extHandled) {
                                    logger.warn({ type: data.type }, 'Unknown IPC task type');
                                }
                            }
                            fs.unlinkSync(processingPath);
                        }
                        catch (err) {
                            logger.error({ file, sourceGroup, err }, 'Error processing IPC task');
                            try {
                                fs.renameSync(processingPath, errorPath);
                            }
                            catch { /* already gone or couldn't move */ }
                        }
                    }
                }
            }
            catch (err) {
                logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
            }
        }
    };
    processIpcFiles();
    logger.info('IPC watcher started (per-group namespaces)');
}
//# sourceMappingURL=ipc-watcher.js.map