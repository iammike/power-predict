// Presentation helper for the MMP table. Splits the displayed duration
// buckets into the default-visible set (≤ splitS) and the collapsible
// long-effort tail (> splitS). Only durations that already have data are
// passed in, so the tail stays empty until the rider logs longer efforts.

export const TABLE_SPLIT_S = 3600; // show through 1h by default

export function partitionDurations(durationsWithData, splitS = TABLE_SPLIT_S) {
  const short = [];
  const long = [];
  for (const d of durationsWithData) {
    (d <= splitS ? short : long).push(d);
  }
  return { short, long };
}
