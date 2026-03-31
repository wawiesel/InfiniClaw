/**
 * Piecewise-constant rate on a union time grid (GDS #113).
 *
 * Notation:
 *   b = bot, s = session_id, x = turn_id, k = token type (in/out/cw/cr)
 *   l = l(b,s,x) = LLM model used by bot b during session s, turn x
 *
 * Fundamental data — token consumption rate [tokens/hr]:
 *
 *   R_{bsxk}(t) = tokens_{bsxk} / (t_end_{bsx} - t_start_{bsx})
 *                 for t in [t_start_{bsx}, t_end_{bsx}), 0 otherwise
 *
 * Cost per token [$/token] for model l:
 *
 *   C_{bsxk} = price_per_token_{l,k}    (immutable, stored at turn start)
 *
 * Cost rate [$/hr]:
 *
 *   $R_{bsx}(t) = sum_k [ R_{bsxk}(t) * C_{bsxk} ]
 *
 * Union grid — collect all t_start_{bsx} and t_end_{bsx} into sorted
 * unique boundaries {g_0, g_1, ..., g_N}, defining N intervals [g_j, g_{j+1}).
 *
 * Combined rate on interval [g_j, g_{j+1}):
 *
 *   R_j = sum over active turns { R_{bsxk} }
 *       where "active" means t_start_{bsx} <= g_j and t_end_{bsx} > g_j
 *
 *   R(t) = R_j for t in [g_j, g_{j+1})    (piecewise constant, plot shape:'hv')
 *
 * Cumulative [tokens]:
 *
 *   C(g_0) = 0
 *   C(g_{j+1}) = C(g_j) + R_j * (g_{j+1} - g_j)
 *   C(t) is monotonically increasing (R_j >= 0)    (piecewise linear, plot shape:'linear')
 *
 * Same structure applies to cost: replace R_{bsxk} with $R_{bsx},
 * sum on the same union grid intervals.
 *
 * RateTimeline is the stateful class for incremental updates.
 * addTurn() is O(log n) for binary search + O(k) for k affected intervals.
 */

export interface Turn {
  t_start: number; // ms since epoch
  t_end: number;   // ms since epoch
  tokens: number;  // total tokens used in this turn
}

export interface RatePoint {
  t: number;      // ms since epoch — start of interval
  rate: number;   // tokens per hour during this interval
}

/**
 * Maintains a piecewise-constant rate function that supports incremental updates.
 * Internally stores sorted grid boundaries and per-interval rates.
 */
export class RateTimeline {
  // Sorted arrays — grid[i] is the start time of interval i, rates[i] is the rate during [grid[i], grid[i+1])
  private grid: number[] = [];
  private rates: number[] = [];  // length = grid.length, last element is always 0 (after last boundary)

  /** Number of grid points. */
  get length(): number { return this.grid.length; }

  /** Add a turn. Only modifies the intervals affected by [t_start, t_end). */
  addTurn(turn: Turn): void {
    const { t_start, t_end, tokens } = turn;
    if (t_end <= t_start || tokens <= 0) return;
    // R_i = tokens_i / (t_end_i - t_start_i)  [tokens/hr]
    const turnRate = tokens / ((t_end - t_start) / 3600_000);

    if (this.grid.length === 0) {
      // First turn — simple init
      this.grid = [t_start, t_end];
      this.rates = [turnRate, 0];
      return;
    }

    // Insert t_start and t_end as boundaries (if not already present)
    this._insertBoundary(t_start);
    this._insertBoundary(t_end);

    // R_j = sum of R_i for all i where t_start_i <= g_j and t_end_i > g_j
    const lo = this._indexOf(t_start);
    const hi = this._indexOf(t_end);
    for (let i = lo; i < hi; i++) {
      this.rates[i] += turnRate;
    }
  }

  /** Get the full rate series. Returns a reference — do not mutate. */
  getRates(): RatePoint[] {
    const result: RatePoint[] = [];
    for (let i = 0; i < this.grid.length; i++) {
      result.push({ t: this.grid[i], rate: this.rates[i] });
    }
    return result;
  }

  /** Get only the rate points in [since, until). Efficient for windowed views. */
  getRatesWindow(since: number, until: number): RatePoint[] {
    const result: RatePoint[] = [];
    for (let i = 0; i < this.grid.length; i++) {
      const t = this.grid[i];
      if (t >= until) break;
      const nextT = i + 1 < this.grid.length ? this.grid[i + 1] : t;
      if (nextT > since) {
        result.push({ t, rate: this.rates[i] });
      }
    }
    return result;
  }

  /** Build cumulative from rate. */
  getCumulative(since?: number): { t: number; cum: number }[] {
    const rates = since != null ? this.getRatesWindow(since, Infinity) : this.getRates();
    return buildCumulative(rates);
  }

  /** Binary search for index of t in grid. */
  private _indexOf(t: number): number {
    let lo = 0, hi = this.grid.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.grid[mid] < t) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  /** Insert a boundary at time t if not already present. Splits the interval. */
  private _insertBoundary(t: number): void {
    const idx = this._indexOf(t);
    if (idx < this.grid.length && this.grid[idx] === t) return; // already exists

    // Insert at idx — the new interval inherits the rate of the interval it splits
    const inheritedRate = idx > 0 ? this.rates[idx - 1] : 0;
    this.grid.splice(idx, 0, t);
    this.rates.splice(idx, 0, inheritedRate);
  }
}

// ── Stateless helpers (used by tests and batch construction) ──

/**
 * Build a piecewise-constant rate function from a set of turns.
 * For batch construction. For incremental use, prefer RateTimeline.
 */
export function buildRate(turns: Turn[]): RatePoint[] {
  const tl = new RateTimeline();
  for (const t of turns) tl.addTurn(t);
  return tl.getRates();
}

/**
 * Reconstruct cumulative tokens from piecewise-constant rate.
 * cumulative(t) = integral of rate from first time to t.
 */
export function buildCumulative(rates: RatePoint[]): { t: number; cum: number }[] {
  if (rates.length === 0) return [];
  let cum = 0;
  const result: { t: number; cum: number }[] = [{ t: rates[0].t, cum: 0 }];
  for (let i = 0; i < rates.length - 1; i++) {
    const dt_hrs = (rates[i + 1].t - rates[i].t) / 3600_000;
    cum += rates[i].rate * dt_hrs;
    result.push({ t: rates[i + 1].t, cum });
  }
  return result;
}
