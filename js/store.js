// A tiny key-value store in the phone's own browser storage (IndexedDB).
// Nothing here ever leaves the device. Two keys are used:
//   "signatures" - her saved signatures (vector strokes)
//   "session"    - the open document and what she has filled in so far, so
//                  that a reload, a crash or a closed app reopens her work
//
// Every call fails SOFT: a private window or blocked storage must cost the
// convenience, never the app.

const DB = "pdf-form-mobile";
const STORE = "kv";

let dbPromise = null;

function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function run(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

export async function get(key) {
  try { return await run("readonly", (s) => s.get(key)); }
  catch (err) { console.warn("store.get", key, err); return undefined; }
}

export async function put(key, value) {
  try { await run("readwrite", (s) => s.put(value, key)); return true; }
  catch (err) { console.warn("store.put", key, err); return false; }
}

export async function del(key) {
  try { await run("readwrite", (s) => s.delete(key)); }
  catch (err) { console.warn("store.del", key, err); }
}
