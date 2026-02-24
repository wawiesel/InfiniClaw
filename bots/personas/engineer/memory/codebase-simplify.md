# Codebase Simplification Learnings

## lizard CCN Analysis
- Install: `pip3 install --user lizard`
- Run: `~/.local/bin/lizard path/to/file.ts -s cyclomatic_complexity`
- Warning threshold: CCN > 15

## Refactoring Patterns That Worked

### Switch Statement Extraction (handleInfiniClawCommand CCN 37 → 9)
1. Create helper functions for shared parsing logic (parseChatJid, parseBot, truncateOutput)
2. Extract each case into a dedicated handler function
3. Keep the switch as a clean dispatcher calling handlers
4. Use consistent patterns across all handlers

### Callback Extraction (processGroupMessages CCN 35 → below warning)
1. Define an interface for the callback context (OutputHandlerContext)
2. Create a factory function that returns the callback
3. Extract nested conditionals into separate handler functions
4. Pass state mutations as callbacks (onOutputSent, onError, etc.)

## Common Mistakes to Avoid
- Dead code in extracted interfaces (onCompletion never called)
- Behavior changes when moving code: if original set state before a potential throw, preserve that order
- Inconsistent helper usage (handleGitPush manually parsed chatJid instead of using parseChatJid)

## lizard Quirks
- TypeScript object property syntax can confuse it (stopNudgeTimer: () => {...} parsed as function name)
- Anonymous functions inside other functions get counted separately
