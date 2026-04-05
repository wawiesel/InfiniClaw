import path from 'path';

import { mergeSystemRecord } from '../merge-system-record/merge-system-record.js';
import { readJsonFile } from '../read-json-file/read-json-file.js';
import type { BootstrapInput, SystemRecord } from '../types.js';
import { writeJsonFile } from '../write-json-file/write-json-file.js';

/**
 * Purpose: insert or update one system entry in the fleet public registry.
 * Requirement: beacon bootstrap must materialize system registration in systems.json.
 */
export function upsertSystemRecord(input: BootstrapInput, apply: boolean): { systemsPath: string; systemRecord: SystemRecord } {
  const file = path.join(input.publicDir, 'systems.json');
  const data = readJsonFile<Record<string, SystemRecord>>(file) ?? {};
  const merged = mergeSystemRecord(data[input.systemId], input);
  data[input.systemId] = merged;
  if (apply) writeJsonFile(file, data);
  return { systemsPath: file, systemRecord: merged };
}
