#!/usr/bin/env node
import { start, stop, chat, send } from './service.js';

const [cmd, ...args] = process.argv.slice(2);
switch (cmd) {
  case 'start': start(); break;
  case 'stop': stop(); break;
  case 'chat':
    if (!args[0]) { console.error('Usage: cli chat <bot>'); process.exit(1); }
    chat(args[0]);
    break;
  case 'send':
    if (args.length < 2) { console.error('Usage: cli send <room> <message>'); process.exit(1); }
    send(args[0], args.slice(1).join(' ')).catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
    break;
  default:
    console.error('Usage: cli start|stop|chat|send');
    process.exit(1);
}
