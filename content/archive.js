/* global window, chrome, indexedDB */
(function () {
  "use strict";

  const STORAGE_KEY = "bookmarkArchiveV1";
  const SCHEMA_VERSION = 1;
  const DB_NAME = "xbm-archive-db";
  const DB_STORE = "xbm-archive-store";
  const DB_KEY = "archive";

  let dbPromise = null;
  let backend = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      try {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          req.result.createObjectStore(DB_STORE);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error("IndexedDB open failed"));
      } catch (err) {
        reject(err);
      }
    });
    return dbPromise;
  }

  async function detectBackend() {
    if (backend) return backend;
    try {
      await openDb();
      backend = "idb";
    } catch (_) {
      backend = "local";
    }
    return backend;
  }

  function localGet() {
    return new Promise((resolve, reject) => {
      chrome.storage.local.get(STORAGE_KEY, (result) => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve(result[STORAGE_KEY]);
      });
    });
  }

  function localSet(value) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.set({ [STORAGE_KEY]: value }, () => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve();
      });
    });
  }

  function localRemove() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.remove(STORAGE_KEY, () => resolve());
      } catch (_) {
        resolve();
      }
    });
  }

  function idbRead() {
    return openDb().then(
      (db) =>
        new Promise((resolve, reject) => {
          try {
            const tx = db.transaction(DB_STORE, "readonly");
            const req = tx.objectStore(DB_STORE).get(DB_KEY);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => reject(req.error || new Error("IndexedDB read failed"));
          } catch (err) {
            reject(err);
          }
        })
    );
  }

  function idbWrite(value) {
    return openDb().then(
      (db) =>
        new Promise((resolve, reject) => {
          try {
            const tx = db.transaction(DB_STORE, "readwrite");
            tx.objectStore(DB_STORE).put(value, DB_KEY);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error || new Error("IndexedDB write failed"));
          } catch (err) {
            reject(err);
          }
        })
    );
  }

  function validArchive(archive) {
    if (!archive || archive.schemaVersion !== SCHEMA_VERSION) return null;
    return Array.isArray(archive.bookmarks) ? archive.bookmarks : [];
  }

  function normalizeBookmark(bookmark, seenAt) {
    if (!bookmark?.id) return null;
    return {
      ...bookmark,
      id: String(bookmark.id),
      bookmarkedAt: bookmark.bookmarkedAt || seenAt,
      lastSeenAt: seenAt,
    };
  }

  async function load() {
    const useIdb = (await detectBackend()) === "idb";
    const found = validArchive(useIdb ? await idbRead() : await localGet());
    if (found) return found;
    if (useIdb) {
      const legacy = validArchive(await localGet().catch(() => null));
      if (legacy) {
        await idbWrite({
          schemaVersion: SCHEMA_VERSION,
          updatedAt: new Date().toISOString(),
          count: legacy.length,
          bookmarks: legacy,
        }).catch(() => {});
        localRemove();
        return legacy;
      }
    }
    return [];
  }

  async function save(bookmarks) {
    const payload = {
      schemaVersion: SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
      count: bookmarks.length,
      bookmarks,
    };
    if ((await detectBackend()) === "idb") {
      await idbWrite(payload);
      localRemove();
    } else {
      await localSet(payload);
    }
  }

  function merge(existing, incoming, seenAt = new Date().toISOString()) {
    const merged = new Map();

    for (const bookmark of existing || []) {
      const normalized = normalizeBookmark(bookmark, bookmark.lastSeenAt || seenAt);
      if (normalized) merged.set(normalized.id, normalized);
    }

    for (const bookmark of incoming || []) {
      const normalized = normalizeBookmark(bookmark, seenAt);
      if (!normalized) continue;
      const previous = merged.get(normalized.id);
      merged.set(normalized.id, {
        ...previous,
        ...normalized,
        bookmarkedAt: previous?.bookmarkedAt || normalized.bookmarkedAt,
      });
    }

    return Array.from(merged.values());
  }

  function getSortDate(bookmark) {
    return bookmark.bookmarkedAt || bookmark.createdAt || null;
  }

  function getRangeDate(bookmark) {
    return bookmark.createdAt || bookmark.bookmarkedAt || null;
  }

  function createExport(
    bookmarks,
    options = {},
    exportedAt = new Date().toISOString()
  ) {
    const days = Number.isFinite(options.days) ? options.days : null;
    const from = options.from ? new Date(options.from).getTime() : null;
    const to = options.to ? new Date(options.to).getTime() : null;
    const cutoff = days
      ? new Date(exportedAt).getTime() - days * 24 * 60 * 60 * 1000
      : null;
    const filtered = bookmarks.filter((bookmark) => {
      const date = getRangeDate(bookmark);
      if (!date) return !cutoff && !from && !to;
      const timestamp = new Date(date).getTime();
      if (from && timestamp < from) return false;
      if (to && timestamp > to) return false;
      if (cutoff && timestamp < cutoff) return false;
      return true;
    });
    const sorted = [...filtered].sort(
      (a, b) =>
        new Date(getRangeDate(b) || getSortDate(b) || 0) -
        new Date(getRangeDate(a) || getSortDate(a) || 0)
    );

    return {
      schemaVersion: SCHEMA_VERSION,
      source: "x-bookmark-manager",
      exportedAt,
      range: from || to
        ? {
            type: "custom",
            from: from ? new Date(from).toISOString() : null,
            to: to ? new Date(to).toISOString() : null,
            dateField: "createdAt",
            fallbackDateField: "bookmarkedAt",
          }
        : days
          ? {
            type: "rolling",
            days,
            since: new Date(cutoff).toISOString(),
            dateField: "createdAt",
            fallbackDateField: "bookmarkedAt",
          }
          : { type: "all" },
      count: sorted.length,
      bookmarks: sorted,
    };
  }

  window.XBookmarksArchive = {
    load,
    save,
    merge,
    createExport,
  };
})();
