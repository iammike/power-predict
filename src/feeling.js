// Subjective "how am I feeling versus my 90-day bests" adjustment (#248).
// Replaces the old automatic TSB-derived prediction nudge: the rider
// self-reports rather than the model inferring form from training load.
// The multiplier scales a predicted power and is a deliberately small
// envelope — a nudge on top of the fit, not a rewrite of the model.

export const FEELING_PRESETS = [
  { id: 'sharp',     label: 'Sharp',               adjPct: 3 },
  { id: 'normal',    label: 'Normal',              adjPct: 0 },
  { id: 'cruising',  label: 'Just cruising',       adjPct: -3 },
  { id: 'off',       label: 'A touch out of shape', adjPct: -6 },
  { id: 'detrained', label: 'Properly detrained',  adjPct: -10 },
];

export const DEFAULT_FEELING = 'normal';

const BY_ID = new Map(FEELING_PRESETS.map((p) => [p.id, p]));

// Resolve a stored preset id to its preset object, falling back to
// Normal for an unknown or missing id (older cache, hand-edited
// settings, a preset we've since renamed).
export function feelingPreset(id) {
  return BY_ID.get(id) ?? BY_ID.get(DEFAULT_FEELING);
}

// Multiplier on predicted power for a given preset id. 1 = no change.
export function feelingMultiplier(id) {
  return 1 + feelingPreset(id).adjPct / 100;
}
