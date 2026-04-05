#!/usr/bin/env node
import { bootstrapSystem } from './bootstrap-system/bootstrap-system.js';
import { defaultBootstrapInput } from './default-bootstrap-input/default-bootstrap-input.js';
import { parseArgs } from './parse-args/parse-args.js';

const [command] = process.argv.slice(2);
if (command !== 'bootstrap') {
  console.error(
    'Usage: beacon bootstrap ' +
    '--fleet <name> --system-id <id> --name <name> --emoji <emoji> ' +
    '--public-dir <dir> --secrets-dir <dir> --state-dir <dir> ' +
    '--relay-version <version> --relay-repo <dir> [--hostname <host>] [--space-id <id>] [--apply]',
  );
  process.exit(1);
}

const args = parseArgs(process.argv.slice(3));
const input = defaultBootstrapInput({
  fleetName: typeof args.fleet === 'string' ? args.fleet : undefined,
  systemId: typeof args['system-id'] === 'string' ? args['system-id'] : undefined,
  name: typeof args.name === 'string' ? args.name : undefined,
  emoji: typeof args.emoji === 'string' ? args.emoji : undefined,
  hostname: typeof args.hostname === 'string' ? args.hostname : undefined,
  publicDir: typeof args['public-dir'] === 'string' ? args['public-dir'] : undefined,
  secretsDir: typeof args['secrets-dir'] === 'string' ? args['secrets-dir'] : undefined,
  stateDir: typeof args['state-dir'] === 'string' ? args['state-dir'] : undefined,
  relayVersion: typeof args['relay-version'] === 'string' ? args['relay-version'] : undefined,
  relayRepo: typeof args['relay-repo'] === 'string' ? args['relay-repo'] : undefined,
  matrixBaseUrl: typeof args.matrix === 'string' ? args.matrix : undefined,
  giteaBaseUrl: typeof args.gitea === 'string' ? args.gitea : undefined,
  s3BaseUrl: typeof args.s3 === 'string' ? args.s3 : undefined,
  spaceId: typeof args['space-id'] === 'string' ? args['space-id'] : undefined,
  apply: args.apply === true,
});

console.log(JSON.stringify(bootstrapSystem(input), null, 2));
