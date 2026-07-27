import { db, getSetting, setSetting } from './db.js';
import {
  auth, firestore, onAuthChange,
  collection, doc, getDoc, setDoc, getDocs, deleteDoc,
  writeBatch, query, where, serverTimestamp, Timestamp,
  getCountFromServer,
} from './firebase.js';

const TABLES = [
  'transactions', 'categories', 'recurringIncome', 'recurringExpenses',
  'savingsTargets', 'distributions', 'accounts', 'accountSnapshots',
  'friendHoldings', 'friendTransactions', 'accountRates', 'accountTransfers',
  'mortgageOverpayments', 'helpToBuyPayments', 'investmentContributions',
];

// Upload order: smallest + most-precious tables first, so that if the Firestore
// daily write quota runs out mid-upload, the hand-entered data (Bank of Gilulu,
// accounts, settings) has already landed. `transactions` is mostly auto-generated
// distribution children and is by far the largest, so it goes last.
const UPLOAD_ORDER = [
  'settings', 'friendHoldings', 'accounts', 'categories', 'savingsTargets',
  'recurringIncome', 'recurringExpenses', 'friendTransactions',
  'accountRates', 'accountTransfers', 'mortgageOverpayments', 'accountSnapshots', 'distributions', 'transactions',
];

// Firestore rejects any document containing an `undefined` field value, and it
// rejects the whole batch – so one bad record kills 500 writes. IndexedDB is
// happy to store undefined, so records must be scrubbed on the way out.
function sanitize(value) {
  if (Array.isArray(value)) return value.filter(v => v !== undefined).map(sanitize);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (v !== undefined) out[k] = sanitize(v);
    }
    return out;
  }
  return value;
}

const errCode = e => e?.code || e?.message || String(e);

// ── State ─────────────────────────────────────────────────────────────────────
export let syncState = { active: false, error: null };
export let lastPullErrors = [];
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

// ── Local sync queue (for writes that happen before auth is ready) ─────────────
async function enqueue(action, tableName, recordId) {
  try {
    await db.syncQueue.add({ tableName, recordId: String(recordId), action, status: 'pending' });
  } catch (e) {
    console.debug('enqueue failed:', e.message);
  }
}

export async function getPendingSyncCount() {
  return db.syncQueue.where('status').equals('pending').count();
}

export async function flushSyncQueue() {
  if (!auth.currentUser) return 0;
  const pending = await db.syncQueue.where('status').equals('pending').toArray();
  if (pending.length === 0) return 0;

  let flushed = 0;
  for (const item of pending) {
    try {
      if (item.action === 'write') {
        let record;
        if (item.tableName === 'settings') {
          record = await db.settings.get(item.recordId);
        } else {
          record = await db[item.tableName].get(Number(item.recordId));
        }
        if (record) {
          await setDoc(docRef(item.tableName, item.recordId), { ...sanitize(record), _updatedAt: serverTimestamp() });
        }
      } else if (item.action === 'delete') {
        await setDoc(docRef(item.tableName, item.recordId), { _deleted: true, _updatedAt: serverTimestamp() });
      }
      await db.syncQueue.delete(item.id);
      flushed++;
    } catch (e) {
      console.debug('flushSyncQueue item failed, will retry next sync:', item.tableName, item.recordId, e.message);
    }
  }
  if (flushed > 0) notify();
  return flushed;
}

// ── Write/Delete a single record to Firestore ─────────────────────────────────
export async function queueWrite(tableName, id) {
  // Distribution children are never synced – they're regenerated from distributions.
  if (tableName === 'transactions') {
    const tx = await db.transactions.get(Number(id));
    if (tx?.distributionId) return;
  }
  if (!auth.currentUser) {
    // Auth not ready yet – persist locally and flush when auth is restored
    await enqueue('write', tableName, id);
    return;
  }
  try {
    let record;
    if (tableName === 'settings') {
      record = await db.settings.get(id);
    } else {
      record = await db[tableName].get(Number(id));
    }
    if (!record) return;
    await setDoc(docRef(tableName, id), { ...sanitize(record), _updatedAt: serverTimestamp() });
  } catch (e) {
    // Network error – queue for retry
    await enqueue('write', tableName, id);
    console.debug('queueWrite failed, queued for retry:', tableName, id, e.message);
  }
  notify();
}

export async function queueDelete(tableName, id) {
  if (tableName === 'transactions') {
    const tx = await db.transactions.get(Number(id));
    if (tx?.distributionId) return;
  }
  if (!auth.currentUser) {
    await enqueue('delete', tableName, id);
    return;
  }
  try {
    await setDoc(docRef(tableName, id), { _deleted: true, _updatedAt: serverTimestamp() });
  } catch (e) {
    await enqueue('delete', tableName, id);
    console.debug('queueDelete failed, queued for retry:', tableName, id, e.message);
  }
  notify();
}

// ── Pull changes from Firestore into local Dexie ──────────────────────────────
export async function pullFromFirestore(fullPull = false) {
  if (!auth.currentUser) return 0;

  const lastSyncAt = await getSetting('lastSyncAt');
  const sinceTs = (!fullPull && lastSyncAt) ? Timestamp.fromMillis(lastSyncAt) : null;
  let pulled = 0;
  const errors = [];

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
      errors.push(`${tableName}: ${errCode(e)}`);
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
  } catch (e) {
    errors.push(`settings: ${errCode(e)}`);
  }

  // Only advance the watermark if every table came back cleanly. Advancing it
  // after a partial failure would permanently skip the records that failed.
  if (errors.length === 0) {
    await setSetting('lastSyncAt', Date.now());
  } else {
    console.warn('Pull incomplete, watermark not advanced:', errors);
  }
  lastPullErrors = errors;
  return pulled;
}

// Full restore: ignore the incremental watermark and pull every document down.
// This is what recovers a device that has been wiped – "Sync now" cannot, because
// it only ever asks for documents newer than the last successful sync.
export async function downloadAllFromCloud() {
  if (!auth.currentUser) throw new Error('Not signed in');
  await setSetting('lastSyncAt', 0);
  const pulled = await pullFromFirestore(true);
  if (lastPullErrors.length) throw new Error(lastPullErrors.join('; '));
  return pulled;
}

// ── Upload all local data to Firestore ────────────────────────────────────────
export async function uploadAllToFirestore(onProgress) {
  if (!auth.currentUser) throw new Error('Not signed in');
  const uid = auth.currentUser.uid;

  // Resume from wherever a previous attempt stopped, so a quota/network failure
  // doesn't restart at record 0 and burn the whole daily allowance re-writing
  // documents that already uploaded successfully.
  let cursor = null;
  try { cursor = JSON.parse(await getSetting('uploadCursor') || 'null'); } catch {}
  const startIdx = cursor ? Math.max(0, UPLOAD_ORDER.indexOf(cursor.table)) : 0;

  const counts = {};
  let total = 0;
  for (const t of UPLOAD_ORDER) { counts[t] = await db[t].count(); total += counts[t]; }

  // Everything before the resume point is already uploaded
  let done = 0;
  for (let i = 0; i < startIdx; i++) done += counts[UPLOAD_ORDER[i]];
  done += cursor?.offset ?? 0;
  onProgress?.(done, total, cursor ? `resuming at ${cursor.table}` : '');

  const report = { at: Date.now(), uid, tables: [], stoppedAt: null };
  let fatal = null;

  for (let ti = startIdx; ti < UPLOAD_ORDER.length && !fatal; ti++) {
    const tableName = UPLOAD_ORDER[ti];
    let records = await db[tableName].toArray();
    // Distribution children are regenerated locally from distributions – skip
    // them to cut ~92% of write volume and stay inside the free-tier quota.
    if (tableName === 'transactions') records = records.filter(r => !r.distributionId);
    const from = (ti === startIdx && cursor) ? (cursor.offset ?? 0) : 0;
    let uploaded = from;
    let tableErr = null;

    for (let i = from; i < records.length; i += 500) {
      const chunk = records.slice(i, i + 500);
      try {
        const batch = writeBatch(firestore);
        let n = 0;
        for (const record of chunk) {
          const id = tableName === 'settings' ? record.key : record.id;
          if (id === undefined || id === null || id === '') continue;
          batch.set(doc(firestore, 'users', uid, tableName, String(id)), {
            ...sanitize(record), _updatedAt: serverTimestamp(),
          });
          n++;
        }
        if (n > 0) await batch.commit();
        uploaded = i + chunk.length;
        done += chunk.length;
        onProgress?.(done, total, tableName);
      } catch (e) {
        tableErr = errCode(e);
        // Quota exhaustion / permission denial will hit every subsequent write
        // too – stop immediately and save the cursor rather than hammering it.
        if (e?.code === 'resource-exhausted' || e?.code === 'permission-denied' ||
            e?.code === 'unauthenticated') {
          fatal = tableErr;
          report.stoppedAt = { table: tableName, offset: uploaded };
        }
        break;
      }
    }

    report.tables.push({ name: tableName, uploaded, total: records.length, error: tableErr });
    if (tableErr && !fatal) report.stoppedAt = { table: tableName, offset: uploaded };
  }

  if (report.stoppedAt) {
    await setSetting('uploadCursor', JSON.stringify(report.stoppedAt));
  } else {
    await setSetting('uploadCursor', '');
    try {
      await db.syncQueue.clear();
      await setDoc(doc(firestore, 'users', uid), { initializedAt: serverTimestamp() }, { merge: true });
      await setSetting('lastSyncAt', Date.now());
      await setSetting('firestoreUid', uid);
    } catch (e) {
      console.warn('uploadAllToFirestore finalization failed', e);
    }
  }

  report.totalDocs = total;
  await setSetting('lastUploadReport', JSON.stringify(report));

  if (fatal) {
    const hint = fatal === 'resource-exhausted'
      ? ' – Firestore daily write quota exhausted. Resumes where it stopped when you retry (quota resets ~08:00 UK).'
      : '';
    throw new Error(fatal + hint);
  }
  const failed = report.tables.filter(t => t.error);
  if (failed.length) throw new Error(`Failed: ${failed.map(t => `${t.name} (${t.error})`).join(', ')}`);
  return report;
}

// ── Verification helpers (cheap: counts cost 1 read per 1000 docs) ────────────
export async function getCloudCounts() {
  if (!auth.currentUser) throw new Error('Not signed in');
  const out = {};
  for (const t of [...TABLES, 'settings']) {
    try {
      const snap = await getCountFromServer(colRef(t));
      out[t] = snap.data().count;
    } catch (e) {
      out[t] = errCode(e);
    }
  }
  return out;
}

// Single write + read + delete. Proves auth, security rules, network and quota
// in one go, and surfaces the raw Firebase error code on-device.
export async function pingFirestore() {
  if (!auth.currentUser) throw new Error('Not signed in');
  const ref = doc(firestore, 'users', auth.currentUser.uid, '_diagnostics', 'ping');
  const timeout = new Promise((_, rej) =>
    setTimeout(() => rej(Object.assign(new Error('timed out after 8s'), { code: 'deadline-exceeded' })), 8000)
  );
  await Promise.race([
    setDoc(ref, { at: serverTimestamp(), ua: navigator.userAgent.slice(0, 120) }),
    timeout,
  ]);
  const snap = await Promise.race([getDoc(ref), timeout]);
  if (!snap.exists()) throw new Error('write succeeded but read-back returned nothing');
  await deleteDoc(ref).catch(() => {});
  return true;
}

export async function getLastUploadReport() {
  try { return JSON.parse(await getSetting('lastUploadReport') || 'null'); } catch { return null; }
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
export function initSync(onAuthStateChange, afterPull) {
  return onAuthChange(async user => {
    onAuthStateChange?.(user);
    if (!user) { notify(); return; }

    syncState = { active: true, error: null };
    notify();

    try {
      const savedUid = await getSetting('firestoreUid');

      if (savedUid !== user.uid) {
        // First sign-in on this device
        if (await isFirestoreInitialized()) {
          // Another device already seeded Firestore – pull everything down
          await pullFromFirestore(true);
          await afterPull?.().catch(e => console.warn('afterPull:', e));
        } else {
          // This is the first device – push everything up
          await uploadAllToFirestore();
        }
        await setSetting('firestoreUid', user.uid);
      } else {
        // Returning device – pull remote changes, then push any locally queued writes
        await pullFromFirestore();
        await flushSyncQueue();
        await afterPull?.().catch(e => console.warn('afterPull:', e));
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
