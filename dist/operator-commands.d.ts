import type { MatrixChannel } from './channels/matrix.js';
export declare function getCaptainUserId(): string;
export declare function handleOperatorCommand(msg: {
    sender: string;
    content: string;
    chat_jid: string;
    thread_id?: string;
}, matrix: MatrixChannel | null, notifyBot?: (chatJid: string, content: string) => void): boolean;
interface TodoItem {
    content: string;
    status: 'pending' | 'in_progress' | 'completed';
    activeForm?: string;
}
export declare function readTodoItems(folder: string): TodoItem[];
export declare function buildTodoMessage(chatJid: string): string;
export {};
