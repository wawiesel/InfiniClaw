import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

import { COMMANDS, registerHandler } from '../command-registry.js';

/**
 * Regression test for BUG-6: relay crash loop caused by registerHandlers
 * calling registerHandler with a name not in COMMANDS.
 *
 * Extracts handler names from relay.ts's registerHandlers({...}) call and
 * verifies every one has a matching COMMANDS entry.
 */
describe('command registry', () => {
  it('has no duplicate command names', () => {
    const names = COMMANDS.map(c => c.name);
    expect(names.length).toBe(new Set(names).size);
  });

  it('registerHandler throws for unknown command names', () => {
    const noop = async () => {};
    expect(() => registerHandler('nonexistent_command_xyz', noop)).toThrow('Unknown command');
  });

  it('every handler registered in relay.ts has a COMMANDS entry', () => {
    // Parse relay.ts source to extract handler names from registerHandlers({...})
    const relayPath = path.resolve(import.meta.dirname, '..', 'relay.ts');
    const source = fs.readFileSync(relayPath, 'utf-8');

    // Find the registerHandlers({ ... }) block and extract keys
    const match = source.match(/registerHandlers\(\{([\s\S]*?)\n  \}\)/);
    expect(match).toBeTruthy();

    const handlerBlock = match![1];
    // Match lines like "    join: async (" or "    fleet: async ("
    const handlerNames = [...handlerBlock.matchAll(/^\s+(\w+)\s*:\s*async\s/gm)]
      .map(m => m[1]);

    expect(handlerNames.length).toBeGreaterThan(0);

    const commandNames = new Set(COMMANDS.map(c => c.name));
    const missing = handlerNames.filter(name => !commandNames.has(name));

    expect(missing).toEqual([]);
  });

  it('every COMMANDS entry has a valid match function', () => {
    for (const cmd of COMMANDS) {
      expect(typeof cmd.match).toBe('function');
      // Match either "!name"/"?name" (prefix/exact) or with arg (startsWith)
      const prefix = cmd.usage.startsWith('?') ? '?' : '!';
      const matchesBare = cmd.match(`${prefix}${cmd.name}`);
      const matchesWithArg = cmd.match(`${prefix}${cmd.name} test`);
      expect(matchesBare || matchesWithArg).toBe(true);
    }
  });
});
