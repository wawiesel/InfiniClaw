#!/usr/bin/env node
import { start, stop, chat } from './service.js';

const [cmd, ...args] = process.argv.slice(2);
switch (cmd) {
  case 'start': start(); break;
  case 'stop': stop(); break;
  case 'chat':
    if (!args[0]) { console.error('Usage: cli chat <bot>'); process.exit(1); }
    chat(args[0]);
    break;
  default:
    console.error('Usage: cli start|stop|chat <bot>');
    process.exit(1);
}
