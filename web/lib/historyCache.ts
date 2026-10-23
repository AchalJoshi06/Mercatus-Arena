// Client-side local storage cache for candle history using IndexedDB.
// Speeds up chart loading to 0ms on page refresh / tab switch / timeframe switch
// and drastically reduces HTTP requests and load on the server and database.

export interface CachedBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

const DB_NAME = "mercatus_chart_cache";
const STORE_NAME = "candle_history";
const DB_VERSION = 3;

let dbPromise: Promise<IDBDatabase | null> | null = null;

function getDB(): Promise<IDBDatabase | null> {
  if (typeof window === "undefined" || !window.indexedDB) {
    return Promise.resolve(null);
  }
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      try {
        const req = window.indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (db.objectStoreNames.contains(STORE_NAME)) {
            db.deleteObjectStore(STORE_NAME);
          }
          db.createObjectStore(STORE_NAME, { keyPath: "key" });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }
  return dbPromise;
}

export async function getCachedCandles(
  symbol: string,
  resolution: string,
): Promise<CachedBar[] | null> {
  try {
    const db = await getDB();
    if (!db) return null;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, "readonly");
        const store = tx.objectStore(STORE_NAME);
        const req = store.get(`${symbol}:${resolution}`);
        req.onsuccess = () => {
          if (req.result && Array.isArray(req.result.bars) && req.result.bars.length > 0) {
            resolve(req.result.bars);
          } else {
            resolve(null);
          }
        };
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  } catch {
    return null;
  }
}

export async function setCachedCandles(
  symbol: string,
  resolution: string,
  bars: CachedBar[],
): Promise<void> {
  try {
    if (!bars || bars.length === 0) return;
    const db = await getDB();
    if (!db) return;
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    store.put({
      key: `${symbol}:${resolution}`,
      updatedAt: Date.now(),
      bars,
    });
  } catch {}
}

export async function clearCachedCandles(): Promise<void> {
  try {
    const db = await getDB();
    if (!db) return;
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).clear();
  } catch {}
}
