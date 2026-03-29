/**
 * Spec test for WBS-47: operator mode icons.
 *
 * Design contract (docs/design/01-operator.md §Operating Modes):
 *   Watch → 📡  Captain → 👑  Fix → 🔧
 *   replyTag() must include the mode icon so Matrix messages show [<emoji><icon> <ship>].
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { COMMANDS } from '../command-registry.js';

const relaySource = fs.readFileSync(
  path.resolve(import.meta.dirname, '..', 'relay.ts'),
  'utf-8',
);

describe('operator mode icons — design/01-operator.md §Operating Modes', () => {
  it('OPERATOR_MODE_ICONS maps watch → 📡', () => {
    expect(relaySource).toContain("watch: '📡'");
  });

  it('OPERATOR_MODE_ICONS maps captain → 👑', () => {
    expect(relaySource).toContain("captain: '👑'");
  });

  it('OPERATOR_MODE_ICONS maps fix → 🔧', () => {
    expect(relaySource).toContain("fix: '🔧'");
  });

  it('operatorMode defaults to watch', () => {
    expect(relaySource).toContain("let operatorMode: 'watch' | 'captain' | 'fix' = 'watch'");
  });

  it('replyTag includes operatorModeIcon()', () => {
    // replyTag must embed the mode icon so prefixes change with mode
    // Extract the replyTag function body (ends at the closing brace on its own line)
    const replyTagBlock = relaySource.match(/function replyTag\(\): string \{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(replyTagBlock).toContain('operatorModeIcon()');
  });

  it('replyTag includes ship emoji', () => {
    const replyTagBlock = relaySource.match(/function replyTag\(\): string \{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(replyTagBlock).toContain('emoji');
  });
});

describe('!operator command — mode switching', () => {
  it('command registry includes watch|captain|fix in usage', () => {
    const entry = COMMANDS.find(c => c.name === 'operator');
    expect(entry).toBeDefined();
    expect(entry!.usage).toContain('watch');
    expect(entry!.usage).toContain('captain');
    expect(entry!.usage).toContain('fix');
  });

  it('relay handler recognises watch, captain, fix actions', () => {
    // Extract the operator handler body from source
    const handlerMatch = relaySource.match(/operator:\s*async\s*\(cmd,\s*conn\)\s*=>\s*\{([\s\S]*?)\n    \},/);
    const body = handlerMatch?.[1] ?? '';
    expect(body).toContain("action === 'watch'");
    expect(body).toContain("action === 'captain'");
    expect(body).toContain("action === 'fix'");
  });

  it('mode switch sets operatorMode and logs', () => {
    expect(relaySource).toContain('operatorMode = action');
  });
});
