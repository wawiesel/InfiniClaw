/**
 * Send a message to a Matrix room via the room's intercom account.
 * Returns true on success.
 */
export declare function sendViaIntercom(targetJid: string, text: string): Promise<boolean>;
