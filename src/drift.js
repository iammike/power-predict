// Fitness-drift normalization. The all-time curve is dominated by
// peak efforts that may be years old, when the rider was demonstrably
// fitter (or less fit) than today. Without correction, the fit's
// fallback to all-time data anchors on a stranger.
//
// Approach: estimate eFTP at each point in time from a backward
// 90-day window's best 20-min MMP (Coggan 0.95). Anchor eFTP_now from
// the same window ending today. For any older activity with a
// computable eFTP_then, scale its MMP values by `eFTP_now / eFTP_then`
// before merging into rolling-best. Activities whose window is too
// sparse to compute eFTP_then pass through unchanged.

const DAY_MS = 86400_000;
const WINDOW_DAYS = 90;
const SCALE_MIN = 0.7;
const SCALE_MAX = 1.3;

// eFTP for a given timestamp = 0.95 × max 20-min MMP across activities
// in [t - windowDays, t]. Returns null if no activity in the window
// has a 20-min MMP. Falls back to 15-min × 0.93 when no 20-min data
// is available — same hierarchy as estimateFtp().
function eftpAt(activities, t, windowDays = WINDOW_DAYS) {
  const cutoff = t - windowDays * DAY_MS;
  let best20 = 0;
  let best15 = 0;
  for (const a of activities) {
    if (a.startTime > t || a.startTime < cutoff) continue;
    const v20 = a.mmp?.[1200];
    const v15 = a.mmp?.[900];
    if (typeof v20 === 'number' && v20 > best20) best20 = v20;
    if (typeof v15 === 'number' && v15 > best15) best15 = v15;
  }
  if (best20 > 0) return best20 * 0.95;
  if (best15 > 0) return best15 * 0.93;
  return null;
}

// Returns a new activity list with each activity's MMP scaled by
// `eFTP_now / eFTP_then`. Scale clamped to [0.7, 1.3] so a sparse
// historical window can't produce wild adjustments. Activities with
// no computable eFTP_then pass through unchanged.
//
// `now` defaults to the latest activity's startTime, not Date.now() —
// this keeps tests deterministic and handles archives that haven't
// been re-uploaded recently (eFTP_now is anchored to "the freshest
// data we have," not wall-clock time).
export function normalizeForDrift(activities, opts = {}) {
  if (!activities.length) return { activities, eftpNow: null };
  const now = opts.now ?? Math.max(...activities.map((a) => a.startTime));
  const windowDays = opts.windowDays ?? WINDOW_DAYS;
  const eftpNow = eftpAt(activities, now, windowDays);
  if (!eftpNow) return { activities, eftpNow: null };

  const out = activities.map((a) => {
    const eftpThen = eftpAt(activities, a.startTime, windowDays);
    if (!eftpThen) return a;
    const rawScale = eftpNow / eftpThen;
    const scale = Math.max(SCALE_MIN, Math.min(SCALE_MAX, rawScale));
    if (Math.abs(scale - 1) < 0.005) return a;
    const scaledMmp = {};
    for (const d of Object.keys(a.mmp || {})) {
      scaledMmp[d] = a.mmp[d] * scale;
    }
    return { ...a, mmp: scaledMmp, _driftScale: scale };
  });
  return { activities: out, eftpNow };
}

export { eftpAt };
