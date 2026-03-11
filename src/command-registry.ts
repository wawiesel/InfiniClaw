/** Command registry — single source of truth for all x-commands.
 *  Help text and dispatch are auto-generated from this registry. */

export interface RoomConn {
  name: string;
  roomId: string;
  homeserver: string;
  username: string;
  password: string;
  accessToken: string | null;
  syncToken: string | null;
  filterId: string | null;
  userId: string | null;
}

export type RelayHandler = (cmd: string, conn: RoomConn, allConns: RoomConn[]) => Promise<void>;

export interface CommandDef {
  /** The command name without '!' prefix, e.g. 'fleet' */
  name: string;
  /** Usage string shown in help, e.g. '!fleet [room]' */
  usage: string;
  /** Short description shown in help */
  description: string;
  /** Match function — returns true if cmd matches this command */
  match: (cmd: string) => boolean;
  /** Handler function — registered at runtime by relay.ts */
  handler?: RelayHandler;
}

/** Exact match: cmd === '!name' */
function exact(name: string): (cmd: string) => boolean {
  const full = `!${name}`;
  return (cmd) => cmd === full;
}

/** Prefix match: cmd === '!name' or cmd starts with '!name ' */
function prefix(name: string): (cmd: string) => boolean {
  const full = `!${name}`;
  const withSpace = `${full} `;
  return (cmd) => cmd === full || cmd.startsWith(withSpace);
}

/** Starts-with match: cmd starts with '!name ' (requires args) */
function startsWith(name: string): (cmd: string) => boolean {
  const withSpace = `!${name} `;
  return (cmd) => cmd.startsWith(withSpace);
}

export const COMMANDS: CommandDef[] = [
  { name: 'todo',          usage: '!todo [bot]',               description: "show bot's active tasks",              match: prefix('todo') },
  { name: 'fleet',         usage: '!fleet [room]',             description: 'fleet + ship status',                  match: prefix('fleet') },
  { name: 'health',        usage: '!health',                   description: 'fleet health summary',                 match: exact('health') },
  { name: 'report',        usage: '!report [bot]',             description: 'send awake bot(s) to duty room',       match: prefix('report') },
  { name: 'dismiss',       usage: '!dismiss [bot]',            description: 'remove from duty, back to quarters',   match: prefix('dismiss') },
  { name: 'go',            usage: '!go [room] [bot]',          description: 'send bot to a room (no args = list)',  match: prefix('go') },
  { name: 'wake',          usage: '!wake [bot]',               description: 'start container in quarters',          match: prefix('wake') },
  { name: 'sleep',         usage: '!sleep [bot]',              description: 'stop container, quarters only',        match: prefix('sleep') },
  { name: 'rejoin',        usage: '!rejoin [bot]',             description: 'dismiss + report (full reset)',        match: prefix('rejoin') },
  { name: 'refresh',       usage: '!refresh [bot]',            description: 'rebuild + restart (pick up new code)',  match: prefix('refresh') },
  { name: 'transport',     usage: '!transport <bot> <ship>',   description: 'beam bot to another ship',             match: startsWith('transport') },
  { name: 'promote',       usage: '!promote <target>',         description: 'raise rank (bot or ship)',             match: startsWith('promote') },
  { name: 'demote',        usage: '!demote <target>',          description: 'lower rank (bot or ship)',             match: startsWith('demote') },
  { name: 'commission',    usage: '!commission [ship]',        description: 'commission ship, start bots',          match: prefix('commission') },
  { name: 'decommission',  usage: '!decommission [ship]',     description: 'stop all bots, keep relay',            match: prefix('decommission') },
  { name: 'pull',           usage: '!pull [ship]',               description: 'pull repos, rebuild, deploy, wake bots', match: prefix('pull') },
  { name: 'push',          usage: '!push [ship]',               description: 'git push InfiniClaw to origin',         match: prefix('push') },
  { name: 'allow',         usage: '!allow <bot> <path> [min]', description: 'grant rw mount (authorized)',          match: startsWith('allow') },
  { name: 'deny',          usage: '!deny <bot> <path>',        description: 'revoke rw mount (authorized)',         match: startsWith('deny') },
  { name: 'operator',      usage: '!operator [on|off] [ship]',  description: 'operator relay status or toggle',       match: prefix('operator') },
];

/** Register a handler for a command by name. */
export function registerHandler(name: string, handler: RelayHandler): void {
  const cmd = COMMANDS.find(c => c.name === name);
  // Sanitize name before interpolating into error message to prevent log injection.
  if (!cmd) throw new Error(`Unknown command: ${name.replace(/[^\w-]/g, '_')}`);
  cmd.handler = handler;
}

/** Register handlers in bulk. */
export function registerHandlers(handlers: Record<string, RelayHandler>): void {
  for (const [name, handler] of Object.entries(handlers)) {
    registerHandler(name, handler);
  }
}

/** Maximum length of a command string accepted by dispatch. Prevents DoS via long strings. */
const MAX_CMD_LENGTH = 512;

/** Find and execute the matching command handler. Returns true if matched. */
export async function dispatch(cmd: string, conn: RoomConn, allConns: RoomConn[]): Promise<boolean> {
  if (cmd.length > MAX_CMD_LENGTH) return false;
  for (const def of COMMANDS) {
    if (def.match(cmd)) {
      if (def.handler) {
        await def.handler(cmd, conn, allConns);
      } else {
        console.warn(`[command-registry] command '${def.name}' matched but has no registered handler`);
      }
      return true;
    }
  }
  return false;
}

/** Generate help text for the ! command. */
export function buildHelpText(): string {
  const maxUsage = Math.max(...COMMANDS.map(c => c.usage.length));
  const lines = COMMANDS.map(c => `  ${c.usage.padEnd(maxUsage)} — ${c.description}`);
  return ['📟 X-commands:', ...lines, `  ${'!'.padEnd(maxUsage)} — this help`].join('\n');
}
