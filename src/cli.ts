#!/usr/bin/env node
import {
  installRelay, startRelay, stopRelay, uninstallRelay,
} from './service.js';

const [cmd, sub] = process.argv.slice(2);

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

if (cmd !== 'relay') {
  fail('Usage: cli relay install|start|stop|uninstall');
}

switch (sub) {
  case 'install':
    installRelay().catch((err) => fail(err instanceof Error ? err.message : String(err)));
    break;
  case 'start':
    try { startRelay(); } catch (err) { fail(err instanceof Error ? (err as Error).message : String(err)); }
    break;
  case 'stop':
    try { stopRelay(); } catch (err) { fail(err instanceof Error ? (err as Error).message : String(err)); }
    break;
  case 'uninstall':
    try { uninstallRelay(); } catch (err) { fail(err instanceof Error ? (err as Error).message : String(err)); }
    break;
  default:
    fail('Usage: cli relay install|start|stop|uninstall');
}
