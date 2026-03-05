import type { AvailableGroup } from 'nanoclaw/container-runner.js';
import { RegisteredGroup } from 'nanoclaw/types.js';
export declare function getAvailableGroups(): AvailableGroup[];
/** @internal - exported for testing */
export declare function _setRegisteredGroups(groups: Record<string, RegisteredGroup>): void;
