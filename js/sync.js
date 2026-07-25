import { db, getSetting, setSetting } from './db.js';
import {
  auth, firestore, onAuthChange,
  collection, doc, getDoc, setDoc, getDocs,
  writeBatch, query, where, serverTimestamp, Timestamp,
} from './firebase.js';

const TABLES = [
  'transactions', 'categories', 'recurringIncome', 'recurringExpenses',
  'savingsTargets', 'distributions', 'accounts', 'accountSnapshots',
  'friendHoldings', 'friendTransactions',
];

// ── State ─────────────────────────────────────────────────────────────────────
export let syncState = { active: false, error: null };
const _listeners = new Set();
export const onSync = cb => { _listeners.add(cb); return () => _listeners.delete(cb); };
const notify = () => _listeners.forEach(cb => cb());

// ── Helpers ───────────────────────────────────────────────────────────────────
function colRef(tableName) {
  return collection(firestore, 'users', auth.currentUser.uid, tableName);
}

function docRef(tableName, id) {
  return doc(firestore, 'users', auth.currentUser.uid, tableName, String(id));
}

// ── Write/Delete a single record to Firestore ─────────────────────────────────
export async function queueWrite(tableName, id) {
  if (!auth.currentUser) return;
  try {
    let record;
    if (tableName === 'settings') {
      record = await db.settings.get(id);
    } else {
      record = await db[tableName].get(Number(id));
    }
    if (!record) return;
    await setDoc(docRef(tableName, id), { ...record, _updatedAt: serverTimestamp() });
  } catch (e) {
    // Firestore offline persistence will retry automatically
    console.debug('queueWrite offline, will retry:', tableName, id);
  }
  notify();
}

export async function queueDelete(tableName, id) {
  if (!auth.currentUser) return;
  try {
    await setDoc(docRef(tableName, id), { _deleted: true, _updatedAt: serverTimestamp() });
  } catch (e) {
    console.debug('queueDelete offline, will retry:', tableName, id);
  }
  notify();
}

// ── Pull changes from Firestore into local Dexie ──────────────────────────────
export async function pullFromFirestore(fullPull = false) {
  if (!auth.currentUser) return 0;

  const lastSyncAt = await getSetting('lastSyncAt');
  const sinceTs = (!fullPull && lastSyncAt) ? Timestamp.fromMillis(lastSyncAt) : null;
  let pulled = 0;

  for (const tableName of TABLES) {
    try {
      const q = sinceTs
        ? query(colRef(tableName), where('_updatedAt', '>', sinceTs))
        : colRef(tableName);
      const snap = await getDocs(q);
      if (snap.empty) continue;

      const toUpsert = [];
      const toDelete = [];
      for (const d of snap.docs) {
        const data = { ...d.data() };
        const deleted = data._deleted;
        delete data._updatedAt;
        delete data._deleted;
        if (deleted) toDelete.push(Number(d.id));
        else toUpsert.push(data);
      }
      if (toUpsert.length) await db[tableName].bulkPut(toUpsert);
      if (toDelete.length) await db[tableName].bulkDelete(toDelete);
      pulled += snap.size;
    } catch (e) {
      console.warn('Pull failed for', tableName, e.message);
    }
  }

  // Settings (key-based)
  try {
    const sq = sinceTs ? query(colRef('settings'), where('_updatedAt', '>', sinceTs)) : colRef('settings');
    const sSnap = await getDocs(sq);
    for (const d of sSnap.docs) {
      const data = { ...d.data() };
      delete data._updatedAt;
      delete data._deleted;
      // Never overwrite local sync-control settings from cloud
      if (!['lastSyncAt', 'firestoreUid'].includes(data.key)) {
        await db.settings.put(data);
      }
    }
  } catch {}

  await setSetting('lastSyncAt', Date.now());
  return pulled;
}

// ── Upload all local data to Firestore (first device) ─────────────────────────
export async function uploadAllToFirestore(onProgress) {
  if (!auth.currentUser) return;
  const uid = auth.currentUser.uid;
  const allTables = [...TABLES, 'settings'];

  let total = 0;
  let done = 0;
  for (const t of allTables) total += await db[t].count();
  onProgress?.(0, total);

  for (const tableName of allTables) {
    const records = await db[tableName].toArray();
    for (let i = 0; i < records.length; i += 500) {
      const chunk = records.slice(i, i + 500);
      const batch = writeBatch(firestore);
      for (const record of chunk) {
        const id = tableName === 'settings' ? record.key : String(record.id);
        batch.set(doc(firestore, 'users', uid, tableName, id), {
          ...record, _updatedAt: serverTimestamp(),
        });
      }
      await batch.commit();
      done += chunk.length;
      onProgress?.(done, total);
    }
  }

  // Sentinel so other devices know Firestore is populated
  await setDoc(doc(firestore, 'users', uid), { initializedAt: serverTimestamp() }, { merge: true });
  await setSetting('lastSyncAt', Date.now());
  await setSetting('firestoreUid', uid);
}

async function isFirestoreInitialized() {
  try {
    const snap = await getDoc(doc(firestore, 'users', auth.currentUser.uid));
    return snap.exists();
  } catch {
    return false;
  }
}

// ── Bootstrap sync on sign-in ─────────────────────────────────────────────────
export function initSync(onAuthStateChange) {
  return onAuthChange(async user => {
    onAuthStateChange?.(user);
    if (!user) { notify(); return; }

    syncState = { active: true, error: null };
    notify();

    try {
      // Complete any pending redirect sign-in
      const savedUid = await getSetting('firestoreUid');

      if (savedUid !== user.uid) {
        // First sign-in on this device
        if (await isFirestoreInitialized()) {
          // Another device already seeded Firestore — pull everything down
          await pullFromFirestore(true);
        } else {
          // This is the first device — push everything up
          await uploadAllToFirestore();
        }
        await setSetting('firestoreUid', user.uid);
      } else {
        // Returning device — delta sync
        await pullFromFirestore();
      }
    } catch (e) {
      syncState = { active: false, error: e.message };
      console.error('Sync error:', e);
      notify();
      return;
    }

    syncState = { active: false, error: null };
    notify();
  });
}
