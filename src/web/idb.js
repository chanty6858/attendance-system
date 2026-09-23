// Offline storage layer. Uses IndexedDB, and transparently falls back to an
// in-memory store when IndexedDB is unavailable (private mode, storage blocked,
// or an open() that never completes), so the app is never left hanging.

const DB_NAME = 'attendance';
const DB_VERSION = 2;
const OPEN_TIMEOUT_MS = 4000;

let dbPromise = null;
let memory = null;

const mem = () => {
  if (!memory) memory = { kv: new Map(), outbox: new Map(), guest_outbox: new Map() };
  return memory;
};

function req(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function openIdb() {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err || new Error('indexedDB unavailable'));
      }
    };
    const timer = setTimeout(() => fail(new Error('indexedDB open timed out')), OPEN_TIMEOUT_MS);
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'event_id' });
        if (!db.objectStoreNames.contains('guest_outbox')) db.createObjectStore('guest_outbox', { keyPath: 'guest_id' });
      };
      request.onsuccess = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(request.result);
      };
      request.onerror = () => fail(request.error);
      request.onblocked = () => fail(new Error('indexedDB blocked'));
    } catch (err) {
      fail(err);
    }
  });
}

export function idb() {
  if (!dbPromise) dbPromise = openIdb().catch(() => null);
  return dbPromise;
}

// Runs an operation against an object store, falling back to memory on failure.
async function use(name, mode, fn) {
  try {
    const db = await idb();
    if (!db) return fn(null);
    const store = db.transaction(name, mode).objectStore(name);
    return await fn(store);
  } catch {
    return fn(null);
  }
}

export async function kvGet(key) {
  return use('kv', 'readonly', (store) =>
    store ? req(store.get(key)) : mem().kv.get(key),
  );
}

export async function kvSet(key, value) {
  return use('kv', 'readwrite', (store) =>
    store ? req(store.put(value, key)) : (mem().kv.set(key, value), undefined),
  );
}

export async function outboxAdd(event) {
  return use('outbox', 'readwrite', (store) =>
    store ? req(store.put(event)) : (mem().outbox.set(event.event_id, event), undefined),
  );
}

export async function outboxAll() {
  return use('outbox', 'readonly', (store) =>
    store ? req(store.getAll()).then((r) => r || []) : [...mem().outbox.values()],
  );
}

export async function outboxCount() {
  return use('outbox', 'readonly', (store) =>
    store ? req(store.count()) : mem().outbox.size,
  );
}

export async function outboxDelete(ids) {
  return use('outbox', 'readwrite', (store) => {
    if (!store) {
      for (const id of ids) mem().outbox.delete(id);
      return undefined;
    }
    return Promise.all(ids.map((id) => req(store.delete(id))));
  });
}

export async function guestOutboxAdd(guest) {
  return use('guest_outbox', 'readwrite', (store) =>
    store ? req(store.put(guest)) : (mem().guest_outbox.set(guest.guest_id, guest), undefined),
  );
}

export async function guestOutboxAll() {
  return use('guest_outbox', 'readonly', (store) =>
    store ? req(store.getAll()).then((r) => r || []) : [...mem().guest_outbox.values()],
  );
}

export async function guestOutboxCount() {
  return use('guest_outbox', 'readonly', (store) =>
    store ? req(store.count()) : mem().guest_outbox.size,
  );
}

export async function guestOutboxDelete(ids) {
  return use('guest_outbox', 'readwrite', (store) => {
    if (!store) {
      for (const id of ids) mem().guest_outbox.delete(id);
      return undefined;
    }
    return Promise.all(ids.map((id) => req(store.delete(id))));
  });
}
