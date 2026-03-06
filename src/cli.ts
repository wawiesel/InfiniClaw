#!/usr/bin/env node
import {
  start, stop, chat, send, sync,
  holodeckCreate, holodeckChat, holodeckTeardown, holodeckPromote,
  startRelay, stopRelay, resolveRoot,
} from './service.js';

const [cmd, ...args] = process.argv.slice(2);

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function parseBot(value: string | undefined, usage: string): string {
  if (!value) fail(usage);
  // Bot names are used in process names and filesystem paths.
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/i.test(value)) {
    fail(`Invalid bot name: ${value}`);
  }
  return value;
}

function parseBranch(value: string | undefined, usage: string): string {
  if (!value) fail(usage);
  // Keep branch syntax conservative because it is forwarded into git shell commands.
  if (!/^[A-Za-z0-9._/-]{1,128}$/.test(value) || value.startsWith('-') || value.includes('..') || value.includes('//') || value.includes('@{')) {
    fail(`Invalid branch name: ${value}`);
  }
  return value;
}

function runSync(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

switch (cmd) {
  case 'start':
    start(args[0]).catch((err) => { console.error(err.message); process.exit(1); });
    break;
  case 'stop':
    stop(args[0]).catch((err) => { console.error(err.message); process.exit(1); });
    break;
  case 'chat':
    runSync(() => chat(parseBot(args[0], 'Usage: cli chat <bot>')));
    break;
  case 'send':
    if (args.length < 2) { console.error('Usage: cli send <room> <message>'); process.exit(1); }
    send(args[0], args.slice(1).join(' ')).catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
    break;
  case 'sync': {
    const direction = args[0];
    if (direction !== 'push' && direction !== 'pull') {
      console.error('Usage: cli sync push|pull');
      process.exit(1);
    }
    sync(direction).catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
    break;
  }
  case 'holodeck': {
    const [sub, ...hArgs] = args;
    switch (sub) {
      case 'create':
        runSync(() => holodeckCreate(
          parseBot(hArgs[0], 'Usage: cli holodeck create <bot> <branch>'),
          parseBranch(hArgs[1], 'Usage: cli holodeck create <bot> <branch>'),
        ));
        break;
      case 'chat':
        runSync(() => holodeckChat(parseBot(hArgs[0], 'Usage: cli holodeck chat <bot>')));
        break;
      case 'teardown':
        runSync(() => holodeckTeardown(parseBot(hArgs[0], 'Usage: cli holodeck teardown <bot>')));
        break;
      case 'promote':
        runSync(() => holodeckPromote(parseBot(hArgs[0], 'Usage: cli holodeck promote <bot>')));
        break;
      default:
        console.error('Usage: cli holodeck create|chat|teardown|promote');
        process.exit(1);
    }
    break;
  }
  case 'relay': {
    const sub = args[0];
    if (sub === 'start') {
      runSync(() => startRelay(resolveRoot()));
    } else if (sub === 'stop') {
      runSync(() => stopRelay());
    } else {
      console.error('Usage: cli relay start|stop');
      process.exit(1);
    }
    break;
  }
  default:
    console.error('Usage: cli start|stop|chat|send|sync|holodeck|relay');
    process.exit(1);
}
