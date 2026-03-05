/**
 * Machine configuration.
 * Reads ~/.config/infiniclaw/machine.json to determine which bots run on this machine,
 * where secrets are stored, and optional S3 sync settings.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
const CONFIG_PATH = path.join(os.homedir(), '.config', 'infiniclaw', 'machine.json');
let cached = null;
export function loadMachineConfig() {
    if (cached)
        return cached;
    if (!fs.existsSync(CONFIG_PATH)) {
        throw new Error(`Missing machine config: ${CONFIG_PATH}\n` +
            'Create it with at minimum:\n' +
            '{\n  "bots": ["bot1", "bot2"],\n  "secretsPath": "/path/to/secrets"\n}');
    }
    let raw;
    try {
        raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    }
    catch (err) {
        throw new Error(`machine.json: invalid JSON in ${CONFIG_PATH}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!Array.isArray(raw.bots) || raw.bots.length === 0) {
        throw new Error(`machine.json: "bots" must be a non-empty array`);
    }
    if (typeof raw.secretsPath !== 'string' || !raw.secretsPath) {
        throw new Error(`machine.json: "secretsPath" must be a non-empty string`);
    }
    if (!fs.existsSync(raw.secretsPath)) {
        throw new Error(`machine.json: secretsPath does not exist: ${raw.secretsPath}`);
    }
    const config = {
        bots: raw.bots,
        secretsPath: raw.secretsPath,
    };
    if (typeof raw.containerNetwork === 'string') {
        if (!/^[a-z][a-z0-9_-]*$/i.test(raw.containerNetwork)) {
            throw new Error(`machine.json: "containerNetwork" must be a valid network name (got "${raw.containerNetwork}")`);
        }
        config.containerNetwork = raw.containerNetwork;
    }
    if (raw.s3) {
        const s3 = raw.s3;
        if (typeof s3.endpoint !== 'string' || typeof s3.bucket !== 'string' ||
            typeof s3.accessKey !== 'string' || typeof s3.secretKey !== 'string') {
            throw new Error('machine.json: "s3" requires endpoint, bucket, accessKey, secretKey');
        }
        config.s3 = s3;
    }
    cached = config;
    return config;
}
/** Clear cached config (for testing or reload). */
export function clearMachineConfigCache() {
    cached = null;
}
//# sourceMappingURL=machine-config.js.map