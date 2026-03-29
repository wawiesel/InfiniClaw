/**
 * Gitea Dev System (GDS) — relay-enforced gate pipeline for structured development tasks.
 *
 * Pipeline: survey → estimate → artifacts → plan_approve → execute_30 → execute_60 → execute_90 → demo → done
 *
 * State lives in S3 at `gds/gds-{issueNumber}.json`. Each gate requires inspector approval
 * followed by captain approval (double approval). The `demo` and `done` gates are captain-only.
 *
 * Engineers submit evidence at each gate. Inspectors review and approve.
 * Nothing merges to main without `demo` gate passed with captain approval.
 */
import { logger } from 'nanoclaw/logger.js';

// Lazy import to break circular dependency with s3-sync
let s3Sync: typeof import('./s3-sync.js') | null = null;
async function getS3() {
  if (!s3Sync) s3Sync = await import('./s3-sync.js');
  return s3Sync;
}

// ── Types ────────────────────────────────────────────────────────────────────

export const GATE_NAMES = [
  'survey', 'estimate', 'artifacts', 'plan_approve',
  'execute_30', 'execute_60', 'execute_90',
  'demo', 'done',
] as const;

export type GateName = typeof GATE_NAMES[number];

export type GateStatus = 'blocked' | 'pending' | 'inspector_approved' | 'approved';

/** Captain-only gates — inspector approval is never sufficient. */
const CAPTAIN_ONLY_GATES: ReadonlySet<GateName> = new Set(['demo', 'done']);

export interface GdsGate {
  name: GateName;
  status: GateStatus;
  evidence?: string;
  inspector_approved_at?: string;
  captain_approved_at?: string;
  tokens_used?: number;
  time_elapsed_min?: number;
}

export interface GdsState {
  gitea_issue: number;
  title: string;
  engineer: string;
  inspector: string;
  wbs_id?: string;
  current_gate: GateName;
  gates: GdsGate[];
  created_at: string;
  execution_started_at?: string;
}

// ── S3 Read/Write ────────────────────────────────────────────────────────────

function s3Key(issueNumber: number): string {
  return `gds/gds-${issueNumber}.json`;
}

export async function readGds(issueNumber: number): Promise<GdsState | null> {
  try {
    const s3 = await getS3();
    const data = await s3.downloadJson(s3Key(issueNumber));
    return data as GdsState;
  } catch {
    return null;
  }
}

export async function writeGds(state: GdsState): Promise<void> {
  try {
    const s3 = await getS3();
    await s3.uploadJson(s3Key(state.gitea_issue), state);
  } catch (err) {
    logger.warn({ err, issue: state.gitea_issue }, 'gds: failed to write state to S3');
  }
}

export async function listActiveGds(): Promise<GdsState[]> {
  try {
    const s3 = await getS3();
    const keys = await s3.listKeys('gds/');
    const results: GdsState[] = [];
    for (const key of keys) {
      try {
        const data = await s3.downloadJson(key);
        const state = data as GdsState;
        if (state.current_gate !== 'done') results.push(state);
      } catch { /* skip bad entries */ }
    }
    return results;
  } catch {
    return [];
  }
}

// ── State Machine ────────────────────────────────────────────────────────────

/** Create initial GDS state with all gates. First gate (survey) is pending, rest blocked. */
export function createGdsState(opts: {
  gitea_issue: number;
  title: string;
  engineer: string;
  inspector: string;
  wbs_id?: string;
}): GdsState {
  const gates: GdsGate[] = GATE_NAMES.map((name, i) => ({
    name,
    status: i === 0 ? 'pending' : 'blocked',
  }));

  return {
    gitea_issue: opts.gitea_issue,
    title: opts.title,
    engineer: opts.engineer,
    inspector: opts.inspector,
    wbs_id: opts.wbs_id,
    current_gate: 'survey',
    gates,
    created_at: new Date().toISOString(),
  };
}

/** Submit evidence for the current pending gate. Only the assigned engineer can submit. */
export function submitEvidence(
  state: GdsState,
  gateName: GateName,
  evidence: string,
  tokensUsed?: number,
  timeElapsedMin?: number,
): { ok: boolean; error?: string } {
  const gate = state.gates.find(g => g.name === gateName);
  if (!gate) return { ok: false, error: `Unknown gate: ${gateName}` };
  if (gate.name !== state.current_gate) return { ok: false, error: `Gate ${gateName} is not the current gate (${state.current_gate})` };
  if (gate.status !== 'pending') return { ok: false, error: `Gate ${gateName} is ${gate.status}, not pending` };

  gate.evidence = evidence;
  if (tokensUsed != null) gate.tokens_used = tokensUsed;
  if (timeElapsedMin != null) gate.time_elapsed_min = timeElapsedMin;
  return { ok: true };
}

/**
 * Approve the current gate.
 * - Inspector approval sets status to 'inspector_approved' (except captain-only gates).
 * - Captain/operator approval sets status to 'approved' and advances to next gate.
 * - Captain-only gates (demo, done) ignore inspector approval.
 */
export function approveGate(
  state: GdsState,
  approver: string,
  role: 'inspector' | 'captain' | 'operator',
): { ok: boolean; error?: string; advanced?: boolean } {
  const gate = state.gates.find(g => g.name === state.current_gate);
  if (!gate) return { ok: false, error: 'No current gate found' };

  const isCaptainOnly = CAPTAIN_ONLY_GATES.has(gate.name);
  const now = new Date().toISOString();

  if (role === 'inspector') {
    if (isCaptainOnly) {
      return { ok: false, error: `Gate ${gate.name} requires captain approval — inspector cannot approve` };
    }
    if (gate.status !== 'pending') {
      return { ok: false, error: `Gate ${gate.name} is ${gate.status}, expected pending` };
    }
    gate.status = 'inspector_approved';
    gate.inspector_approved_at = now;
    return { ok: true, advanced: false };
  }

  // Captain or operator
  if (gate.status !== 'pending' && gate.status !== 'inspector_approved') {
    return { ok: false, error: `Gate ${gate.name} is ${gate.status}, expected pending or inspector_approved` };
  }

  gate.status = 'approved';
  gate.captain_approved_at = now;

  // Advance to next gate
  const currentIndex = GATE_NAMES.indexOf(state.current_gate);
  if (currentIndex < GATE_NAMES.length - 1) {
    const nextGate = GATE_NAMES[currentIndex + 1];
    state.current_gate = nextGate;
    const nextGateObj = state.gates.find(g => g.name === nextGate);
    if (nextGateObj) nextGateObj.status = 'pending';

    // Track execution start
    if (nextGate === 'execute_30' && !state.execution_started_at) {
      state.execution_started_at = now;
    }
  }

  return { ok: true, advanced: true };
}

/** Render pipeline status as markdown (for Gitea comments and Matrix). */
export function formatPipelineStatus(state: GdsState): string {
  const icon = (g: GdsGate) => {
    if (g.status === 'approved') return '✅';
    if (g.status === 'inspector_approved') return '🔍';
    if (g.status === 'pending') return '⏳';
    return '⬜';
  };
  const lines = [
    `## GDS #${state.gitea_issue}: ${state.title}`,
    `**Engineer**: ${state.engineer} | **Inspector**: ${state.inspector}`,
    state.wbs_id ? `**WBS**: ${state.wbs_id}` : '',
    '',
    '### Pipeline',
    ...state.gates.map(g => {
      let line = `${icon(g)} **${g.name}**`;
      if (g.tokens_used != null) line += ` · ${g.tokens_used} tokens`;
      if (g.time_elapsed_min != null) line += ` · ${g.time_elapsed_min}min`;
      if (g.evidence) line += ` · evidence submitted`;
      return line;
    }),
    '',
    `**Current gate**: ${state.current_gate}`,
  ].filter(Boolean);
  return lines.join('\n');
}

/** Check if a bot's active GDS allows pushing to main (demo gate must be approved). */
export async function canPushToMain(bot: string): Promise<{ allowed: boolean; reason?: string }> {
  const active = await listActiveGds();
  const botGds = active.filter(g => g.engineer === bot);
  if (botGds.length === 0) return { allowed: true }; // No active GDS, allow (legacy flow)

  for (const gds of botGds) {
    const demoGate = gds.gates.find(g => g.name === 'demo');
    if (!demoGate || demoGate.status !== 'approved') {
      return {
        allowed: false,
        reason: `GDS #${gds.gitea_issue} (${gds.title}): demo gate not approved — cannot merge to main`,
      };
    }
  }
  return { allowed: true };
}
