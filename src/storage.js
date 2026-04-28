// IndexedDB cache for parsed activity records and user settings.
//
// `activities` keeps the per-ride MMP arrays so returning visits hydrate
// instantly. `settings` stores the manual fit override so a user-defined
// CP / date range survives reloads. startTime (unix ms) is the
// activities key — two rides can't start in the same millisecond.

const DB_NAME = 'power-predict';
const DB_VERSION = 2;
const ACTIVITIES_STORE = 'activities';
const SETTINGS_STORE = 'settings';
const SETTINGS_KEY = 'current';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(ACTIVITIES_STORE)) {
        db.createObjectStore(ACTIVITIES_STORE, { keyPath: 'startTime' });
      }
      if (!db.objectStoreNames.contains(SETTINGS_STORE)) {
        db.createObjectStore(SETTINGS_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(name, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(name, mode);
    const store = tx.objectStore(name);
    let result;
    Promise.resolve(fn(store))
      .then((r) => { result = r; })
      .catch(reject);
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function loadActivities() {
  return withStore(ACTIVITIES_STORE, 'readonly', (store) =>
    new Promise((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    })
  );
}

export async function saveActivities(activities) {
  if (activities.length === 0) return;
  return withStore(ACTIVITIES_STORE, 'readwrite', (store) => {
    for (const a of activities) store.put(a);
  });
}

export async function hasActivity(startTime) {
  return withStore(ACTIVITIES_STORE, 'readonly', (store) =>
    new Promise((resolve, reject) => {
      const req = store.getKey(startTime);
      req.onsuccess = () => resolve(req.result !== undefined);
      req.onerror = () => reject(req.error);
    })
  );
}

export async function clearActivities() {
  return withStore(ACTIVITIES_STORE, 'readwrite', (store) => store.clear());
}

export async function activityCount() {
  return withStore(ACTIVITIES_STORE, 'readonly', (store) =>
    new Promise((resolve, reject) => {
      const req = store.count();
      req.onsuccess = () => resolve(req.result || 0);
      req.onerror = () => reject(req.error);
    })
  );
}

// ───── Settings ─────

export async function loadSettings() {
  return withStore(SETTINGS_STORE, 'readonly', (store) =>
    new Promise((resolve, reject) => {
      const req = store.get(SETTINGS_KEY);
      req.onsuccess = () => resolve(req.result || {});
      req.onerror = () => reject(req.error);
    })
  );
}

export async function saveSettings(settings) {
  return withStore(SETTINGS_STORE, 'readwrite', (store) => {
    store.put(settings, SETTINGS_KEY);
  });
}

export async function clearSettings() {
  return withStore(SETTINGS_STORE, 'readwrite', (store) => store.clear());
}
