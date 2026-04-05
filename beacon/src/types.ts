export interface SystemRecord {
  name: string;
  emoji: string;
  hostname: string;
  spaceId?: string;
}

export interface BeaconState {
  fleetName: string;
  systemId: string;
  relayVersion: string;
  relayRepo: string;
  publicDir: string;
  secretsDir: string;
  stateDir: string;
  installedAt: string;
}

export interface BootstrapInput {
  fleetName: string;
  systemId: string;
  name: string;
  emoji: string;
  hostname: string;
  publicDir: string;
  secretsDir: string;
  stateDir: string;
  relayVersion: string;
  relayRepo: string;
  matrixBaseUrl: string;
  giteaBaseUrl: string;
  s3BaseUrl: string;
  spaceId?: string;
  apply: boolean;
}

export interface BootstrapStep {
  id: string;
  description: string;
}

export interface BootstrapResult {
  steps: BootstrapStep[];
  systemRecord: SystemRecord;
  systemsPath: string;
  beaconStatePath: string;
  relayStartCommand: string[];
}
