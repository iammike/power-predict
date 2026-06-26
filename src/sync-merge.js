// Decide which synced activities the client needs to (re)write to its
// IndexedDB cache. A remote activity is written when it is new (no
// cached row at that startTime) or when its mmpVersion differs from the
// cached copy. The latter is how a server-side re-extraction (new
// bucket set) propagates into the local cache. startTime (unix ms) is
// the IDB key, so two rides can't collide on it.
export function activitiesToRefresh(remoteActivities, cachedActivities) {
  const cachedVersionByStart = new Map();
  for (const a of cachedActivities) cachedVersionByStart.set(a.startTime, a.mmpVersion);
  return remoteActivities.filter((r) => {
    if (!cachedVersionByStart.has(r.startTime)) return true;
    return cachedVersionByStart.get(r.startTime) !== r.mmpVersion;
  });
}
