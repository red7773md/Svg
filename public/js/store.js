// Saving pictures in the browser (IndexedDB), so history survives a reload.
// If IndexedDB is unavailable (private windows in some browsers), it falls
// back to memory for the current visit and says so via `persistent`.
//
// Two object stores keep saves cheap:
//   jobs     everything small: settings, shapes, log, thumbnail
//   sources  the stored photo, written once

import { DB_NAME, DB_VERSION } from './config.js';

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Save was cancelled'));
  });
}

function memoryStore() {
  const jobs = new Map();
  const sources = new Map();
  return {
    persistent: false,
    async list() { return [...jobs.values()].sort((a, b) => b.updatedAt - a.updatedAt); },
    async get(id) { return jobs.get(id) || null; },
    async put(job) { jobs.set(job.id, job); },
    async putSource(id, blob) { sources.set(id, blob); },
    async getSource(id) { return sources.get(id) || null; },
    async remove(id) { jobs.delete(id); sources.delete(id); },
  };
}

export async function openStore() {
  if (typeof indexedDB === 'undefined') return memoryStore();
  let db;
  try {
    db = await new Promise((resolve, reject) => {
      const open = indexedDB.open(DB_NAME, DB_VERSION);
      open.onupgradeneeded = () => {
        const d = open.result;
        if (!d.objectStoreNames.contains('jobs')) d.createObjectStore('jobs', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('sources')) d.createObjectStore('sources');
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
      open.onblocked = () => reject(new Error('blocked'));
    });
  } catch {
    return memoryStore();
  }

  // Ask the browser not to evict our data under storage pressure. Best effort.
  try { navigator.storage?.persist?.(); } catch { /* ignore */ }

  return {
    persistent: true,
    async list() {
      const all = await request(db.transaction('jobs').objectStore('jobs').getAll());
      return all.sort((a, b) => b.updatedAt - a.updatedAt);
    },
    async get(id) {
      return (await request(db.transaction('jobs').objectStore('jobs').get(id))) || null;
    },
    async put(job) {
      const tx = db.transaction('jobs', 'readwrite');
      tx.objectStore('jobs').put(job);
      await transactionDone(tx);
    },
    async putSource(id, blob) {
      const tx = db.transaction('sources', 'readwrite');
      tx.objectStore('sources').put(blob, id);
      await transactionDone(tx);
    },
    async getSource(id) {
      return (await request(db.transaction('sources').objectStore('sources').get(id))) || null;
    },
    async remove(id) {
      const tx = db.transaction(['jobs', 'sources'], 'readwrite');
      tx.objectStore('jobs').delete(id);
      tx.objectStore('sources').delete(id);
      await transactionDone(tx);
    },
  };
}
