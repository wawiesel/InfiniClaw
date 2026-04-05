import fs from 'fs';
import os from 'os';
import path from 'path';

import { readJsonFile, writeJsonFile } from './json-store.js';
import type {
  BeaconState,
  BootstrapInput,
  BootstrapResult,
  BootstrapStep,
  SystemRecord,
} from './types.js';

function assertNonEmpty(value: string, field: string): void {
  if (!value.trim()) throw new Error(`${field} is required`);
}

function assertDirExists(dir: string, field: string): void {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error(`${field} must point to an existing directory: ${dir}`);
  }
}

function systemsJsonPath(publicDir: string): string {
  return path.join(publicDir, 'systems.json');
}

function beaconStatePath(stateDir: string): string {
  return path.join(stateDir, 'beacon-state.json');
}

function buildRelayStartCommand(input: BootstrapInput): string[] {
  return [
    'node',
    path.join(input.relayRepo, 'dist', 'cli.js'),
    'relay',
    'start',
  ];
}

function buildSteps(input: BootstrapInput): BootstrapStep[] {
  return [
    { id: 'verify-input', description: 'verify bootstrap inputs' },
    { id: 'verify-public', description: `verify ${input.publicDir} is a usable fleet public working copy` },
    { id: 'verify-secrets', description: `verify ${input.secretsDir} is a usable fleet secrets working copy` },
    { id: 'register-system', description: `register or update system ${input.systemId} in systems.json` },
    { id: 'write-state', description: 'write local beacon state' },
    { id: 'start-relay', description: 'emit the first relay start command' },
  ];
}

function validateInput(input: BootstrapInput): void {
  assertNonEmpty(input.fleetName, 'fleetName');
  assertNonEmpty(input.systemId, 'systemId');
  assertNonEmpty(input.name, 'name');
  assertNonEmpty(input.emoji, 'emoji');
  assertNonEmpty(input.hostname, 'hostname');
  assertNonEmpty(input.publicDir, 'publicDir');
  assertNonEmpty(input.secretsDir, 'secretsDir');
  assertNonEmpty(input.stateDir, 'stateDir');
  assertNonEmpty(input.relayVersion, 'relayVersion');
  assertNonEmpty(input.relayRepo, 'relayRepo');
  assertNonEmpty(input.matrixBaseUrl, 'matrixBaseUrl');
  assertNonEmpty(input.giteaBaseUrl, 'giteaBaseUrl');
  assertNonEmpty(input.s3BaseUrl, 's3BaseUrl');
  assertDirExists(input.publicDir, 'publicDir');
  assertDirExists(input.secretsDir, 'secretsDir');
}

function mergeSystemRecord(existing: SystemRecord | undefined, input: BootstrapInput): SystemRecord {
  return {
    name: input.name,
    emoji: input.emoji,
    hostname: input.hostname,
    spaceId: input.spaceId ?? existing?.spaceId,
  };
}

function upsertSystemRecord(input: BootstrapInput, apply: boolean): { systemsPath: string; systemRecord: SystemRecord } {
  const file = systemsJsonPath(input.publicDir);
  const data = readJsonFile<Record<string, SystemRecord>>(file) ?? {};
  const merged = mergeSystemRecord(data[input.systemId], input);
  data[input.systemId] = merged;
  if (apply) writeJsonFile(file, data);
  return { systemsPath: file, systemRecord: merged };
}

function writeBeaconState(input: BootstrapInput, apply: boolean): string {
  const state: BeaconState = {
    fleetName: input.fleetName,
    systemId: input.systemId,
    relayVersion: input.relayVersion,
    relayRepo: input.relayRepo,
    publicDir: input.publicDir,
    secretsDir: input.secretsDir,
    stateDir: input.stateDir,
    installedAt: new Date().toISOString(),
  };
  const file = beaconStatePath(input.stateDir);
  if (apply) writeJsonFile(file, state);
  return file;
}

export function bootstrapSystem(input: BootstrapInput): BootstrapResult {
  validateInput(input);
  if (input.apply) fs.mkdirSync(input.stateDir, { recursive: true });
  const { systemsPath, systemRecord } = upsertSystemRecord(input, input.apply);
  const statePath = writeBeaconState(input, input.apply);
  return {
    steps: buildSteps(input),
    systemRecord,
    systemsPath,
    beaconStatePath: statePath,
    relayStartCommand: buildRelayStartCommand(input),
  };
}

export function defaultBootstrapInput(partial: Partial<BootstrapInput>): BootstrapInput {
  const hostname = partial.hostname ?? os.hostname();
  return {
    fleetName: partial.fleetName ?? 'OGIC',
    systemId: partial.systemId ?? hostname.toLowerCase(),
    name: partial.name ?? hostname,
    emoji: partial.emoji ?? '🌊',
    hostname,
    publicDir: partial.publicDir ?? path.join(os.homedir(), '.config', 'infiniclaw', 'public'),
    secretsDir: partial.secretsDir ?? path.join(os.homedir(), '.config', 'infiniclaw', 'secrets'),
    stateDir: partial.stateDir ?? path.join(os.homedir(), '.config', 'infiniclaw', 'beacon'),
    relayVersion: partial.relayVersion ?? 'v2.0.0',
    relayRepo: partial.relayRepo ?? path.join(os.homedir(), 'src', 'infiniclaw-relay'),
    matrixBaseUrl: partial.matrixBaseUrl ?? 'https://matrix.a-gis.org',
    giteaBaseUrl: partial.giteaBaseUrl ?? 'https://gitea.a-gis.org',
    s3BaseUrl: partial.s3BaseUrl ?? 'https://s3.a-gis.org',
    spaceId: partial.spaceId,
    apply: partial.apply ?? false,
  };
}
