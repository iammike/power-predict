// IndexedDB cache for parsed activity records. Keeps returning visits
// instant: we never re-parse the zip if the user has been here before.
// startTime (unix ms) is the natural key — two rides can't start in the
// same millisecond.

const DB_NAME = 'power-predict';
const DB_VERSION = 1;
const STORE = 'activities';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'startTime' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
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
  return withStore('readonly', (store) =>
    new Promise((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    })
  );
}

export async function saveActivities(activities) {
  if (activities.length === 0) return;
  return withStore('readwrite', (store) => {
    for (const a of activities) store.put(a);
  });
}

export async function hasActivity(startTime) {
  return withStore('readonly', (store) =>
    new Promise((resolve, reject) => {
      const req = store.getKey(startTime);
      req.onsuccess = () => resolve(req.result !== undefined);
      req.onerror = () => reject(req.error);
    })
  );
}

export async function clearActivities() {
  return withStore('readwrite', (store) => store.clear());
}

export async function activityCount() {
  return withStore('readonly', (store) =>
    new Promise((resolve, reject) => {
      const req = store.count();
      req.onsuccess = () => resolve(req.result || 0);
      req.onerror = () => reject(req.error);
    })
  );
}
