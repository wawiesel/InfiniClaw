import { TRIGGER_PATTERN } from 'nanoclaw/config.js';
import type { NewMessage } from 'nanoclaw/types.js';

export type ResumeHistoryMessage = Pick<NewMessage, 'sender_name' | 'content'>;

interface ResumeSystemMessageInput {
  taskBlock?: string;
  missionContext?: string;
  recentMessages?: ResumeHistoryMessage[];
  pendingBranchBrainResults?: string;
}

function formatRecentResumeMessages(recentMessages: ResumeHistoryMessage[]): string | undefined {
  if (recentMessages.length === 0) return undefined;
  const lines = recentMessages.map((message) => {
    const sanitized = message.content
      .slice(0, 300)
      .replace(new RegExp(TRIGGER_PATTERN.source, 'gi'), '[callout]');
    return `[${message.sender_name}]: ${sanitized}`;
  });
  return `Here are the last ${recentMessages.length} messages before restart:\n${lines.join('\n')}`;
}

export function buildResumeSystemMessage({
  taskBlock = '',
  missionContext,
  recentMessages = [],
  pendingBranchBrainResults = '',
}: ResumeSystemMessageInput): string {
  const contextSections: string[] = [];
  if (missionContext) contextSections.push(missionContext);
  const recentBlock = formatRecentResumeMessages(recentMessages);
  if (recentBlock) contextSections.push(recentBlock);

  const contextBlock = contextSections.length > 0
    ? `\n\n${contextSections.join('\n\n')}`
    : '';
  const pendingBlock = pendingBranchBrainResults
    ? `\n\nPending Branch Brain results:${pendingBranchBrainResults}`
    : '';

  return 'You were restarted. Reconstruct what you were working on from the mission context, active tasks, and recent messages below. '
    + 'Do not send a public status reply to this system message. Continue only if there is unfinished work or a queued message still needs action; '
    + `otherwise wait silently for the next instruction.${taskBlock}${contextBlock}${pendingBlock}`;
}
