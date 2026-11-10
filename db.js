// Local database (IndexedDB). Everything is saved on the device, so the app works offline.
const DB_NAME = 'quickticket';
const VERSION = 1;
export const STORES = ['customers', 'items', 'docs', 'meta'];
let dbPromise;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        for (const s of STORES) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s, { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function run(store, mode, fn) {
  const d = await open();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req ? req.result : undefined);
    t.onerror = () => reject(t.error);
  });
}

export const db = {
  all: store => run(store, 'readonly', s => s.getAll()),
  get: (store, id) => run(store, 'readonly', s => s.get(id)),
  async put(store, value) {
    value.updatedAt = new Date().toISOString();
    await run(store, 'readwrite', s => { s.put(value); });
    return value;
  },
  del: (store, id) => run(store, 'readwrite', s => { s.delete(id); }),
  clear: store => run(store, 'readwrite', s => { s.clear(); }),
};

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
