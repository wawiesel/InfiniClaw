# Engineering Spec: Profile Env Encryption (Security Fix)

**Author**: Architect
**Date**: 2026-02-26
**Status**: Draft
**Priority**: High (Security)

---

## Summary

Bot profile environment files (`bots/profiles/{bot}/env`) currently store sensitive credentials in plaintext, including Claude OAuth tokens, Anthropic API keys, and Matrix authentication secrets. This spec implements macOS Keychain integration for high-value secrets while preserving plaintext storage for non-sensitive configuration. The approach uses keychain references in env files (e.g., `BRAIN_OAUTH_TOKEN=keychain:bot-engineer-BRAIN_OAUTH_TOKEN`) that are resolved at load time by the host process before injection into containers.

---

## Problem

### Current State
Profile env files contain plaintext secrets:
```bash
# bots/profiles/engineer/env
BRAIN_OAUTH_TOKEN=sk-ant-sid01-xxxxxxxxxxxxxxxxxxxxxxxxxxxxx
BRAIN_API_KEY=sk-ant-api03-xxxxxxxxxxxxxxxxxxxxxxxxxxxxx
MATRIX_USERNAME=@engineer:matrix.org
MATRIX_PASSWORD=hunter2
MATRIX_ACCESS_TOKEN=syt_xxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

### Security Risk
- **Filesystem exposure**: Anyone with host filesystem access can read API keys
- **Accidental leakage**: Risk of committing secrets during development (despite `.gitignore`)
- **Privilege escalation**: Compromised low-privilege process can steal high-value credentials
- **Audit trail**: No record of when/who accessed secrets

### Current Loading Mechanism
Secrets are loaded by `src/service.ts:loadProfileEnv()` which calls `parseEnvFile()` from NanoClaw, then injects them as environment variables into containers. This host-side loading is the correct interception point for keychain resolution.

---

## Solution

### Recommended Approach: macOS Keychain for High-Value Secrets

Use macOS Keychain to store individual secrets with references in env files. This approach:
- Integrates naturally with macOS security model
- Requires no passphrase for trusted apps
- Provides per-secret granularity
- Maintains auditability (config file shows which secrets are used)
- Preserves plaintext for non-sensitive config (no overhead)

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ bots/profiles/engineer/env (plaintext config + references) │
│                                                               │
│ BOT_NAME=engineer                                            │
│ LOG_LEVEL=info                                               │
│ BRAIN_OAUTH_TOKEN=keychain:bot-engineer-BRAIN_OAUTH_TOKEN   │
│ BRAIN_API_KEY=keychain:bot-engineer-BRAIN_API_KEY           │
│ MATRIX_PASSWORD=keychain:bot-engineer-MATRIX_PASSWORD       │
└─────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│ service.ts: loadProfileEnv()                                 │
│                                                               │
│ 1. parseEnvFile() → raw key-value pairs                     │
│ 2. For each value starting with "keychain:":                │
│    - Extract account name                                    │
│    - Call resolveKeychainRef(account)                        │
│    - Replace reference with actual secret                    │
│ 3. Return resolved env object                                │
└─────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│ macOS Keychain                                               │
│                                                               │
│ Account: bot-engineer-BRAIN_OAUTH_TOKEN                      │
│ Password: sk-ant-sid01-xxxxxxxxxxxxxxxxxxxxxxxxxxxxx         │
│                                                               │
│ Account: bot-engineer-BRAIN_API_KEY                          │
│ Password: sk-ant-api03-xxxxxxxxxxxxxxxxxxxxxxxxxxxxx         │
└─────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│ Container receives resolved env vars                         │
│                                                               │
│ BRAIN_OAUTH_TOKEN=sk-ant-sid01-xxxxxxxx (actual value)      │
│ BRAIN_API_KEY=sk-ant-api03-xxxxxxxx (actual value)          │
└─────────────────────────────────────────────────────────────┘
```

### Reference Format
- **Keychain reference**: `keychain:{account}`
- **Account naming convention**: `bot-{botname}-{KEY}`
  - Example: `keychain:bot-engineer-BRAIN_OAUTH_TOKEN`
- **Service name** (for all items): `infiniclaw`

### Secrets to Migrate
High-value secrets requiring keychain storage:
- `BRAIN_OAUTH_TOKEN` (Claude OAuth)
- `BRAIN_API_KEY` (Anthropic API)
- `MATRIX_PASSWORD` (Matrix auth)
- `MATRIX_ACCESS_TOKEN` (Matrix auth)
- Any future `*_TOKEN`, `*_KEY`, `*_PASSWORD`, `*_SECRET` values

Non-sensitive config remains in plaintext:
- `BOT_NAME`, `LOG_LEVEL`, `MATRIX_USERNAME`, `MATRIX_HOMESERVER`, etc.

---

## Implementation

### 1. New Helper: `resolveKeychainRef()`

**Location**: `src/service.ts` (add near `loadProfileEnv()`)

```typescript
/**
 * Resolves a keychain reference to its stored secret value.
 *
 * @param account - Keychain account name (e.g., "bot-engineer-BRAIN_OAUTH_TOKEN")
 * @returns The secret value stored in the keychain
 * @throws Error if keychain item not found or security command fails
 */
function resolveKeychainRef(account: string): string {
  const service = 'infiniclaw';

  try {
    // Use -w flag to get password only (no extra output)
    const result = execSync(
      `security find-generic-password -a "${service}" -s "${account}" -w 2>/dev/null`,
      { encoding: 'utf8' }
    );

    return result.trim();
  } catch (error) {
    throw new Error(
      `Failed to resolve keychain reference: ${account}\n` +
      `Make sure the keychain item exists. Use:\n` +
      `  npx ts-node src/cli.ts keychain-set --bot <bot> --key <KEY> --value <value>`
    );
  }
}
```

**Dependencies**: Add `import { execSync } from 'child_process';` at top of file if not already present.

---

### 2. Modify `loadProfileEnv()`

**Location**: `src/service.ts:loadProfileEnv()`

**Current implementation** (approximate):
```typescript
function loadProfileEnv(botName: string): Record<string, string> {
  const envPath = path.join(PROFILES_DIR, botName, 'env');
  const env = parseEnvFile(envPath);
  return env;
}
```

**New implementation**:
```typescript
function loadProfileEnv(botName: string): Record<string, string> {
  const envPath = path.join(PROFILES_DIR, botName, 'env');
  const rawEnv = parseEnvFile(envPath);

  // Resolve keychain references
  const resolvedEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawEnv)) {
    if (typeof value === 'string' && value.startsWith('keychain:')) {
      const account = value.slice('keychain:'.length);
      try {
        resolvedEnv[key] = resolveKeychainRef(account);
      } catch (error) {
        throw new Error(
          `Failed to load env for bot "${botName}": ${error.message}`
        );
      }
    } else {
      resolvedEnv[key] = value;
    }
  }

  return resolvedEnv;
}
```

---

### 3. New CLI Command: `keychain-set`

**Location**: New file `src/cli-keychain.ts` (or extend existing `src/cli.ts`)

```typescript
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const PROFILES_DIR = path.join(__dirname, '../bots/profiles');
const SERVICE = 'infiniclaw';

interface KeychainSetOptions {
  bot: string;
  key: string;
  value: string;
}

/**
 * Stores a secret in macOS Keychain and updates the bot's env file with a reference.
 *
 * Usage: npx ts-node src/cli.ts keychain-set --bot engineer --key BRAIN_OAUTH_TOKEN --value "sk-ant-..."
 */
export function keychainSet(options: KeychainSetOptions): void {
  const { bot, key, value } = options;

  // Validate inputs
  if (!bot || !key || !value) {
    throw new Error('Missing required options: --bot, --key, --value');
  }

  const profilePath = path.join(PROFILES_DIR, bot);
  if (!fs.existsSync(profilePath)) {
    throw new Error(`Profile not found: ${bot}`);
  }

  const account = `bot-${bot}-${key}`;
  const envPath = path.join(profilePath, 'env');

  // Step 1: Store secret in keychain
  console.log(`Storing secret in keychain: ${account}`);
  try {
    // Try to delete existing item first (ignore errors if not found)
    try {
      execSync(`security delete-generic-password -a "${SERVICE}" -s "${account}" 2>/dev/null`);
      console.log('  (replaced existing keychain item)');
    } catch {
      // Item didn't exist, that's fine
    }

    // Add new keychain item
    execSync(
      `security add-generic-password -a "${SERVICE}" -s "${account}" -w "${value}"`,
      { stdio: 'inherit' }
    );
    console.log('✓ Secret stored in keychain');
  } catch (error) {
    throw new Error(`Failed to store secret in keychain: ${error.message}`);
  }

  // Step 2: Update env file with keychain reference
  console.log(`Updating env file: ${envPath}`);
  let envContent = fs.readFileSync(envPath, 'utf8');

  const reference = `keychain:${account}`;
  const keyPattern = new RegExp(`^${key}=.*$`, 'm');

  if (keyPattern.test(envContent)) {
    // Replace existing value
    envContent = envContent.replace(keyPattern, `${key}=${reference}`);
    console.log(`  (replaced existing ${key})`);
  } else {
    // Add new line
    envContent += `\n${key}=${reference}\n`;
    console.log(`  (added new ${key})`);
  }

  fs.writeFileSync(envPath, envContent, 'utf8');
  console.log('✓ Env file updated with keychain reference');
  console.log('');
  console.log(`Successfully configured ${key} for bot "${bot}"`);
  console.log(`The secret is now stored securely in macOS Keychain.`);
}

/**
 * Lists all keychain items for InfiniClaw bots.
 */
export function keychainList(): void {
  console.log('InfiniClaw keychain items:');
  console.log('');

  try {
    const result = execSync(
      `security dump-keychain | grep -A 1 "${SERVICE}" | grep "0x00000007" | cut -d'"' -f 4`,
      { encoding: 'utf8' }
    );

    const accounts = result.trim().split('\n').filter(Boolean);
    if (accounts.length === 0) {
      console.log('  (no keychain items found)');
    } else {
      accounts.forEach(account => console.log(`  - ${account}`));
    }
  } catch (error) {
    console.log('  (no keychain items found or error reading keychain)');
  }
}

// CLI integration
if (require.main === module) {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === 'keychain-set') {
    const bot = args[args.indexOf('--bot') + 1];
    const key = args[args.indexOf('--key') + 1];
    const value = args[args.indexOf('--value') + 1];
    keychainSet({ bot, key, value });
  } else if (command === 'keychain-list') {
    keychainList();
  } else {
    console.log('Usage:');
    console.log('  npx ts-node src/cli-keychain.ts keychain-set --bot <bot> --key <KEY> --value <value>');
    console.log('  npx ts-node src/cli-keychain.ts keychain-list');
    process.exit(1);
  }
}
```

---

## Migration Path

### Phase 1: Implementation (Cid)
1. Add `resolveKeychainRef()` helper to `src/service.ts`
2. Modify `loadProfileEnv()` to resolve keychain references
3. Create `src/cli-keychain.ts` with keychain management commands
4. Test with a single non-critical secret

### Phase 2: Migration (Operator/Captain)
For each bot (engineer, commander, architect):

1. **Backup existing env file**:
   ```bash
   cp bots/profiles/engineer/env bots/profiles/engineer/env.backup
   ```

2. **Migrate secrets to keychain**:
   ```bash
   # Read current value from env file
   CURRENT_TOKEN=$(grep '^BRAIN_OAUTH_TOKEN=' bots/profiles/engineer/env | cut -d'=' -f2)

   # Store in keychain and update env file
   npx ts-node src/cli-keychain.ts keychain-set \
     --bot engineer \
     --key BRAIN_OAUTH_TOKEN \
     --value "$CURRENT_TOKEN"

   # Repeat for each secret:
   # - BRAIN_API_KEY
   # - MATRIX_PASSWORD
   # - MATRIX_ACCESS_TOKEN
   ```

3. **Verify env file**:
   ```bash
   cat bots/profiles/engineer/env
   # Should show: BRAIN_OAUTH_TOKEN=keychain:bot-engineer-BRAIN_OAUTH_TOKEN
   ```

4. **Test bot startup**:
   ```bash
   # Send a test message to the bot
   # Verify it authenticates successfully
   ```

5. **Securely delete backup** (after confirming everything works):
   ```bash
   shred -u bots/profiles/engineer/env.backup  # or rm if shred not available
   ```

### Phase 3: Validation
1. All three bots authenticate successfully
2. No plaintext secrets remain in env files
3. Keychain items exist for all high-value secrets:
   ```bash
   npx ts-node src/cli-keychain.ts keychain-list
   ```

---

## Files to Change

### 1. `src/service.ts`
- **Add**: `resolveKeychainRef()` function (after imports, before `loadProfileEnv()`)
- **Modify**: `loadProfileEnv()` to resolve keychain references
- **Add import**: `import { execSync } from 'child_process';` if not present

### 2. New file: `src/cli-keychain.ts`
- **Create**: Complete CLI tool for keychain management
- **Export**: `keychainSet()`, `keychainList()` functions

### 3. `bots/profiles/*/env` (migration only, not code changes)
- **engineer/env**: Replace secret values with keychain references
- **commander/env**: Replace secret values with keychain references
- **architect/env**: Replace secret values with keychain references

---

## Testing Plan

### Unit Testing (Cid)
1. **Test `resolveKeychainRef()` with mock keychain item**:
   ```bash
   # Create test keychain item
   security add-generic-password -a "infiniclaw" -s "test-item" -w "test-value"

   # Run unit test (add to test suite)
   # Expected: resolveKeychainRef('test-item') returns 'test-value'

   # Cleanup
   security delete-generic-password -a "infiniclaw" -s "test-item"
   ```

2. **Test `loadProfileEnv()` with mixed env file**:
   - Create test profile with both plaintext and keychain references
   - Verify plaintext values pass through unchanged
   - Verify keychain references are resolved
   - Verify error handling for missing keychain items

3. **Test CLI commands**:
   ```bash
   # Test keychain-set
   npx ts-node src/cli-keychain.ts keychain-set \
     --bot test \
     --key TEST_SECRET \
     --value "test-value-123"

   # Verify keychain item exists
   security find-generic-password -a "infiniclaw" -s "bot-test-TEST_SECRET" -w

   # Test keychain-list
   npx ts-node src/cli-keychain.ts keychain-list
   ```

### Integration Testing (Architect on Holodeck)

**Challenge**: Holodeck runs in Podman container, but keychain is host-side. Testing must occur on the **host system** (Captain's workstation), not in holodeck.

**Approach**: Captain/Operator must perform integration testing since keychain access requires host privileges.

#### Test Procedure (Captain/Operator):
1. **Setup test bot profile**:
   ```bash
   mkdir -p bots/profiles/test-bot
   cat > bots/profiles/test-bot/env <<EOF
   BOT_NAME=test-bot
   LOG_LEVEL=debug
   TEST_PLAINTEXT=plaintext-value
   TEST_SECRET=keychain:bot-test-bot-TEST_SECRET
   EOF
   ```

2. **Store test secret in keychain**:
   ```bash
   security add-generic-password \
     -a "infiniclaw" \
     -s "bot-test-bot-TEST_SECRET" \
     -w "secret-value-xyz"
   ```

3. **Test loading**:
   ```bash
   # Add temporary test script to service.ts or create standalone test
   node -e "
   const service = require('./dist/service.js');
   const env = service.loadProfileEnv('test-bot');
   console.log('TEST_PLAINTEXT:', env.TEST_PLAINTEXT);  // Should be plaintext-value
   console.log('TEST_SECRET:', env.TEST_SECRET);        // Should be secret-value-xyz
   "
   ```

4. **Test error handling** (missing keychain item):
   ```bash
   # Add reference without keychain item
   echo "MISSING_SECRET=keychain:bot-test-bot-MISSING" >> bots/profiles/test-bot/env

   # Attempt to load (should fail with clear error message)
   node -e "const service = require('./dist/service.js'); service.loadProfileEnv('test-bot');"
   ```

5. **Cleanup**:
   ```bash
   rm -rf bots/profiles/test-bot
   security delete-generic-password -a "infiniclaw" -s "bot-test-bot-TEST_SECRET"
   ```

### Production Migration Testing (Captain/Operator)
1. Migrate one bot (recommend: architect, lowest risk)
2. Send test message, verify authentication
3. Check logs for keychain resolution errors
4. If successful, migrate remaining bots
5. If issues found, restore from `.backup` files

---

## Testability Notes

**Why holodeck can't fully test this**:
- Holodeck architect runs in Podman container
- macOS Keychain is host-side only (not accessible from container)
- Keychain resolution happens in host process (`service.ts`)
- Container receives already-resolved secrets as env vars

**What Architect CAN test in holodeck**:
- Read/verify Cid's code changes in `service.ts`
- Read/verify CLI tool implementation in `cli-keychain.ts`
- Review error handling and edge cases
- Validate code structure and TypeScript types

**What Captain/Operator MUST test on host**:
- Actual keychain integration
- CLI commands (`keychain-set`, `keychain-list`)
- Production bot startup with keychain references
- End-to-end authentication flow

---

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Keychain access denied | Medium | High | Test on host system first; document required Keychain permissions |
| Migration fails mid-process | Medium | High | Backup all env files before migration; test with one bot first |
| Bot startup fails after migration | Medium | High | Keep `.backup` files until confirmed working; implement clear error messages |
| Keychain item not found at runtime | Low | High | Validate keychain items exist before updating env file; add pre-flight check |
| Secret rotation breaks bots | Low | Medium | Document secret rotation procedure (run `keychain-set` again with new value) |
| Host system reboot clears keychain | Very Low | Medium | macOS Keychain persists across reboots; test after reboot |
| Container escapes and accesses keychain | Very Low | Critical | Keychain resolution happens on host before container receives secrets (by design) |

---

## Acceptance Criteria

### Must Have
- [ ] `resolveKeychainRef()` implemented in `src/service.ts`
- [ ] `loadProfileEnv()` resolves keychain references
- [ ] CLI tool (`cli-keychain.ts`) created with `keychain-set` and `keychain-list` commands
- [ ] All high-value secrets migrated to keychain for all three bots
- [ ] No plaintext secrets remain in env files (verified by grep)
- [ ] All three bots authenticate successfully after migration
- [ ] Error messages clearly indicate when keychain items are missing
- [ ] Backup env files created and securely deleted after validation

### Should Have
- [ ] Unit tests for keychain resolution
- [ ] Integration tests performed on host system (Captain/Operator)
- [ ] Documentation for secret rotation procedure
- [ ] Migration completed for all bots within same maintenance window

### Nice to Have
- [ ] Pre-flight check command: `npx ts-node src/cli-keychain.ts verify --bot <bot>`
- [ ] Audit logging for keychain access attempts
- [ ] Support for other secret backends (future: 1Password, Vault)

---

## Security Considerations

### Threat Model
- **Protected against**: Filesystem disclosure, accidental leakage, low-privilege process access
- **Not protected against**: Root/sudo access, physical access with user logged in, malicious code in host process
- **Acceptable tradeoff**: Keychain provides OS-level protection without requiring passphrase entry for every bot startup

### Secret Rotation Procedure
When secrets need to be rotated (e.g., token compromised):
```bash
# Generate new secret (example: new OAuth token from Claude web UI)
NEW_TOKEN="sk-ant-sid01-NEW_VALUE_HERE"

# Update keychain and env file atomically
npx ts-node src/cli-keychain.ts keychain-set \
  --bot engineer \
  --key BRAIN_OAUTH_TOKEN \
  --value "$NEW_TOKEN"

# Next bot startup will use new secret automatically
```

### Audit Trail
- Keychain access is logged by macOS system (check Console.app → Security logs)
- Env file changes are tracked by git (shows when references were added)
- Bot logs show authentication success/failure

---

## Future Improvements (Out of Scope)

1. **Cross-platform support**: Linux (libsecret), Windows (Credential Manager)
2. **Secret backend abstraction**: Support multiple secret stores
3. **Automatic secret rotation**: Integration with token refresh flows
4. **Secret validation**: Check for expired/invalid tokens at load time
5. **Emergency access**: Generate time-limited plaintext exports for disaster recovery
6. **Secret provenance**: Track which secrets are used by which bots (already partially addressed by naming convention)

---

## Implementation Order (for Cid)

1. Add `resolveKeychainRef()` to `service.ts`
2. Modify `loadProfileEnv()` to resolve references
3. Create `cli-keychain.ts` with management commands
4. Unit test with mock keychain items
5. Hand off to Captain/Operator for host-side integration testing
6. Captain/Operator performs migration (with Cid's support if needed)
7. Architect verifies no plaintext secrets remain (holodeck: `grep -r "sk-ant-" bots/profiles/`)

---

**End of Spec**
