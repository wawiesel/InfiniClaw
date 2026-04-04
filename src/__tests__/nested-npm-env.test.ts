import { describe, expect, it } from 'vitest';

import { nestedNpmEnv, resolveNestedNpmInvocation } from '../service.js';

describe('nestedNpmEnv', () => {
  it('strips inherited npm state but preserves normal host env', () => {
    const result = nestedNpmEnv('/tmp/child', {
      HOME: '/Users/tester',
      PATH: '/usr/local/bin:/usr/bin:/bin',
      NODE_EXTRA_CA_CERTS: '/etc/ssl/custom.pem',
      INIT_CWD: '/Users/tester/root',
      npm_command: 'run-script',
      npm_execpath: '/usr/local/lib/node_modules/npm/bin/npm-cli.js',
      npm_lifecycle_event: 'cli',
      npm_lifecycle_script: 'node dist/cli.js',
      npm_package_json: '/Users/tester/root/package.json',
      npm_package_name: 'infiniclaw',
      npm_package_version: '1.16.5',
      npm_config_local_prefix: '/Users/tester/root',
      npm_config_cache: '/Users/tester/.npm',
    });

    expect(result['HOME']).toBe('/Users/tester');
    expect(result['PATH']).toBe('/usr/local/bin:/usr/bin:/bin');
    expect(result['NODE_EXTRA_CA_CERTS']).toBe('/etc/ssl/custom.pem');
    expect(result['INIT_CWD']).toBe('/tmp/child');

    expect(result['npm_command']).toBeUndefined();
    expect(result['npm_execpath']).toBeUndefined();
    expect(result['npm_lifecycle_event']).toBeUndefined();
    expect(result['npm_lifecycle_script']).toBeUndefined();
    expect(result['npm_package_json']).toBeUndefined();
    expect(result['npm_package_name']).toBeUndefined();
    expect(result['npm_package_version']).toBeUndefined();
    expect(result['npm_config_cache']).toBeUndefined();
    expect(result['npm_config_local_prefix']).toBeUndefined();
  });
});

describe('resolveNestedNpmInvocation', () => {
  it('prefers the launcher npm cli when available', () => {
    const result = resolveNestedNpmInvocation({
      npm_execpath: '/usr/local/lib/node_modules/npm/bin/npm-cli.js',
      npm_node_execpath: '/opt/homebrew/bin/node',
    });

    expect(result).toEqual({
      command: '/opt/homebrew/bin/node',
      args: ['/usr/local/lib/node_modules/npm/bin/npm-cli.js'],
    });
  });

  it('falls back to PATH npm when launcher metadata is absent', () => {
    const result = resolveNestedNpmInvocation({});
    expect(result).toEqual({ command: 'npm', args: [] });
  });
});
