// Parse human duration strings into seconds.
// Accepts: "45m", "2h", "1h30m", "90s", "2h30m45s", with case-insensitive
// units and flexible whitespace. Returns null for unparseable input.

const RE = /^\s*(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?\s*$/i;

export function parseDuration(input) {
  if (typeof input !== 'string') return null;
  const m = input.match(RE);
  if (!m || (!m[1] && !m[2] && !m[3])) return null;
  const h = Number(m[1] || 0);
  const min = Number(m[2] || 0);
  const s = Number(m[3] || 0);
  const total = h * 3600 + min * 60 + s;
  return total > 0 ? total : null;
}
