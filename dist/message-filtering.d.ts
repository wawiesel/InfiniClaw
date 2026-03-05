import type { NewMessage } from 'nanoclaw/types.js';
/** Returns true if the message is addressed to another bot and should be ignored. */
export declare function isIgnoredTrigger(text: string): boolean;
/** Returns true if the message should be ignored (other bot output). */
export declare function shouldIgnoreMessage(msg: NewMessage): boolean;
