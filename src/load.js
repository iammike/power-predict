// Training-load math: TSS per activity, then CTL / ATL / TSB rolling.
//
//   TSS = (IF² × duration_h × 100), where IF = NP / FTP
//   CTL = exponentially-weighted average TSS, time constant 42 days
//   ATL = same, time constant 7 days
//   TSB = CTL - ATL  (positive = fresh, negative = fatigued)
//
// We compute these on demand from cached activities rather than
// persisting daily snapshots, since our archive ingest happens
// once per upload and the EWMA is cheap (one O(N) pass).
//
// Rationale on EWMA vs. simple windowed average: the standard
// Banister/Coggan formulation uses EWMA so a hard ride 30 days
// ago gradually loses influence rather than dropping out abruptly
// at the day-42 boundary. Same for ATL with a 7-day decay.

const DAY_MS = 86_400_000;
const CTL_TAU_DAYS = 42;
const ATL_TAU_DAYS = 7;

// TSS for a single activity. Returns null when we can't form a
// well-defined intensity factor (no FTP, no NP, zero/negative
// duration, etc.). Capped at 600 — even a multi-hour all-out effort
// rarely scores above ~500 TSS, anything beyond is data noise.
export function computeTss(activity, ftpW) {
  if (!activity) return null;
  if (!Number.isFinite(ftpW) || ftpW <= 0) return null;
  const np = Number.isFinite(activity.npW) && activity.npW > 0
    ? activity.npW
    : (Number.isFinite(activity.avgPower) && activity.avgPower > 0
        ? activity.avgPower
        : null);
  if (np === null) return null;
  const durationH = activity.durationS / 3600;
  if (!Number.isFinite(durationH) || durationH <= 0) return null;
  const intensity = np / ftpW;
  const tss = intensity * intensity * durationH * 100;
  return Math.min(600, Math.max(0, tss));
}

// Discrete EWMA in the standard Banister form:
//   load_today = load_yesterday + (tss_today - load_yesterday) / τ
// We bucket activities by day (UTC), sum TSS per day, walk from
// the first day to `now` accumulating two parallel EWMAs (CTL τ=42
// days, ATL τ=7 days).
export function computeLoadSeries(activities, ftpW, opts = {}) {
  if (!Array.isArray(activities) || activities.length === 0) {
    return { ctl: 0, atl: 0, tsb: 0, days: 0, hasFtp: false };
  }
  const hasFtp = Number.isFinite(ftpW) && ftpW > 0;
  if (!hasFtp) return { ctl: 0, atl: 0, tsb: 0, days: 0, hasFtp: false };

  const now = opts.now ?? Date.now();
  const dayKey = (t) => Math.floor(t / DAY_MS);
  const today = dayKey(now);

  // Sum TSS per day key.
  const tssByDay = new Map();
  let firstDay = null;
  for (const a of activities) {
    const d = dayKey(a.startTime);
    if (firstDay === null || d < firstDay) firstDay = d;
    const tss = computeTss(a, ftpW);
    if (!Number.isFinite(tss)) continue;
    tssByDay.set(d, (tssByDay.get(d) || 0) + tss);
  }
  if (firstDay === null) return { ctl: 0, atl: 0, tsb: 0, days: 0, hasFtp: true };

  const startDay = Math.min(firstDay, today - CTL_TAU_DAYS);
  let ctl = 0;
  let atl = 0;
  for (let d = startDay; d <= today; d++) {
    const tss = tssByDay.get(d) || 0;
    ctl = ctl + (tss - ctl) / CTL_TAU_DAYS;
    atl = atl + (tss - atl) / ATL_TAU_DAYS;
  }
  return {
    ctl,
    atl,
    tsb: ctl - atl,
    days: today - startDay + 1,
    hasFtp: true,
  };
}

// Map TSB to a tiny multiplier on the prediction. Conservative
// envelope so this is a nudge, not a rewrite of the model:
//   TSB ≥ +25  →  +5%   (peaking, capped)
//   TSB ≈ 0    →   0%
//   TSB ≤ -25  →  -5%   (deeply fatigued, capped)
// Linear in between. Returns 1 (no adjustment) when TSB isn't
// computable.
export function formMultiplier(tsb, opts = {}) {
  if (!Number.isFinite(tsb)) return 1;
  const cap = opts.capPct ?? 0.05;
  const tsbAtCap = opts.tsbAtCap ?? 25;
  const adj = Math.max(-cap, Math.min(cap, (tsb / tsbAtCap) * cap));
  return 1 + adj;
}

// Categorize the TSB value for UI labelling. Returns one of
// 'fresh' | 'stable' | 'building' | 'overloaded'.
export function tsbBand(tsb) {
  if (!Number.isFinite(tsb)) return 'unknown';
  if (tsb >= 5) return 'fresh';
  if (tsb >= -5) return 'stable';
  if (tsb >= -20) return 'building';
  return 'overloaded';
}
