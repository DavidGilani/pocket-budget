// Bank import: turn raw Lloyds card transactions (queued in Firestore by the
// nightly GitHub Action) into clean, categorised Pocket Ledger transactions.
//
// This module is pure logic + Firestore IO — no DOM. The review UI lives in
// app.js (renderBankImport) and calls into here.
//
// Flow:
//   • The nightly job writes raw rows to users/<uid>/importQueue (status
//     'pending'), only for dates after the go-live cutoff.
//   • proposeForItem() cleans the merchant name and picks a category, using a
//     seed rule pack + rules the user has taught by confirming past items.
//   • Fully-known merchants (high confidence, no extra detail needed) are
//     auto-accepted; everything else waits in the in-app review inbox.
//   • Deduplication is permanent: a confirmed transaction carries the bank's
//     transaction id, and we never import the same id twice.

import { db, getSetting } from './db.js';
import { auth, firestore, collection, doc, getDocs, setDoc, query, where } from './firebase.js';
import { queueWrite } from './sync.js';

// ── Seed rules ────────────────────────────────────────────────────────────────
// `match` is tested (as a substring) against the normalised descriptor. Order
// matters: put more specific entries first (e.g. "uber eats" before "uber").
// Category ids come from SEED_CATEGORIES in db.js.
export const SEED_RULES = [
  // Groceries (cat 2)
  { match: 'tesco', name: 'Tesco', categoryId: 2 },
  { match: 'sainsbury', name: "Sainsbury's", categoryId: 2 },
  { match: 'asda', name: 'Asda', categoryId: 2 },
  { match: 'aldi', name: 'Aldi', categoryId: 2 },
  { match: 'lidl', name: 'Lidl', categoryId: 2 },
  { match: 'waitrose', name: 'Waitrose', categoryId: 2 },
  { match: 'morrison', name: 'Morrisons', categoryId: 2 },
  { match: 'ocado', name: 'Ocado', categoryId: 2 },
  { match: 'iceland', name: 'Iceland', categoryId: 2 },
  { match: 'co op', name: 'Co-op', categoryId: 2 },
  { match: 'coop', name: 'Co-op', categoryId: 2 },
  // Transport (cat 1)
  { match: 'tfl', name: 'Transport for London', categoryId: 1,
    amountRules: [ { match: 'eq', value: 1.75, name: 'Bus', categoryId: 1 },
                   { match: 'default', name: 'Tube', categoryId: 1 } ] },
  { match: 'trainline', name: 'Trainline', categoryId: 1 },
  { match: 'national rail', name: 'Train', categoryId: 1 },
  { match: 'ubereats', name: 'Uber Eats', categoryId: 6 },
  { match: 'uber eats', name: 'Uber Eats', categoryId: 6 },
  { match: 'uber', name: 'Uber', categoryId: 1 },
  { match: 'bolt', name: 'Bolt', categoryId: 1 },
  { match: 'shell', name: 'Shell (fuel)', categoryId: 1 },
  { match: 'esso', name: 'Esso (fuel)', categoryId: 1 },
  { match: 'texaco', name: 'Texaco (fuel)', categoryId: 1 },
  // Takeaway (cat 6) / food out (cat 3) / restaurant (cat 4)
  { match: 'deliveroo', name: 'Deliveroo', categoryId: 6 },
  { match: 'just eat', name: 'Just Eat', categoryId: 6 },
  { match: 'justeat', name: 'Just Eat', categoryId: 6 },
  { match: 'mcdonald', name: "McDonald's", categoryId: 6 },
  { match: 'greggs', name: 'Greggs', categoryId: 3 },
  { match: 'pret', name: 'Pret', categoryId: 3 },
  { match: 'costa', name: 'Costa', categoryId: 3 },
  { match: 'starbucks', name: 'Starbucks', categoryId: 3 },
  { match: 'caffe nero', name: 'Caffè Nero', categoryId: 3 },
  { match: 'nando', name: "Nando's", categoryId: 4 },
  // Entertainment / subscriptions (cat 5)
  { match: 'netflix', name: 'Netflix', categoryId: 5 },
  { match: 'spotify', name: 'Spotify', categoryId: 5 },
  { match: 'disney', name: 'Disney+', categoryId: 5 },
  { match: 'youtube', name: 'YouTube', categoryId: 5 },
  { match: 'cineworld', name: 'Cineworld', categoryId: 5 },
  { match: 'odeon', name: 'Odeon', categoryId: 5 },
  { match: 'amazon prime', name: 'Amazon Prime', categoryId: 5 },
  // Health & beauty (8), clothing (10), household (9)
  { match: 'boots', name: 'Boots', categoryId: 8 },
  { match: 'superdrug', name: 'Superdrug', categoryId: 8 },
  { match: 'primark', name: 'Primark', categoryId: 10 },
  { match: 'uniqlo', name: 'Uniqlo', categoryId: 10 },
  { match: 'ikea', name: 'IKEA', categoryId: 9 },
  { match: 'screwfix', name: 'Screwfix', categoryId: 9 },
  { match: 'argos', name: 'Argos', categoryId: 9 },
  // Catch-alls that need a note (name known, but spend could be anything)
  { match: 'amzn', name: 'Amazon', categoryId: 28, promptDetail: true },
  { match: 'amazon', name: 'Amazon', categoryId: 28, promptDetail: true },
  { match: 'paypal', name: 'PayPal', categoryId: 28, promptDetail: true },
  { match: 'apple', name: 'Apple', categoryId: 28, promptDetail: true },
  { match: 'sumup', name: 'SumUp', categoryId: 28, promptDetail: true },
  { match: 'zettle', name: 'Zettle', categoryId: 28, promptDetail: true },
];

// ── Descriptor cleaning ───────────────────────────────────────────────────────
// Strip Lloyds noise (URLs, country codes, digits, punctuation, company suffixes)
// down to a lowercase token stream we can match rules against.
export function normaliseDescriptor(raw) {
  return (raw || '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\b[\w.-]+\.(co\.uk|com|org|net|gov\.uk|io|uk)\b/g, ' ')
    .replace(/[^a-z ]+/g, ' ')                       // drop digits & punctuation
    .replace(/\b(ltd|limited|plc|gb|uk|the|card|purchase|payment)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function titleCase(s) {
  return (s || '').split(' ').filter(Boolean).slice(0, 3)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// ── Proposal ──────────────────────────────────────────────────────────────────
// Given a queue item and the learned rules, return the suggested name, category,
// whether it needs a note, a confidence level, and the derived amount fields.
export function proposeForItem(item, learnedRules = []) {
  const raw = Number(item.amount) || 0;
  const isDebit = (item.bankType || '').toUpperCase() === 'DEBIT' || raw < 0;
  const absAmount = Math.abs(raw);
  const signedAmount = isDebit ? -absAmount : absAmount;   // expense negative
  const type = isDebit ? 'expense' : 'income';
  const desc = item.description || item.merchant || '';
  const norm = normaliseDescriptor(desc);

  const base = { token: norm, isDebit, signedAmount, absAmount, type };

  // Learned rules win over seed rules (the user's own choices).
  for (const r of learnedRules) {
    if (r.token && norm.includes(r.token)) {
      return { ...base, name: r.name, categoryId: r.categoryId, promptDetail: false, confidence: 'high' };
    }
  }
  for (const r of SEED_RULES) {
    if (norm.includes(r.match)) {
      let name = r.name, categoryId = r.categoryId;
      if (r.amountRules) {
        const hit = r.amountRules.find(a => a.match === 'eq' && Math.abs(absAmount - a.value) < 0.005)
          || r.amountRules.find(a => a.match === 'default');
        if (hit) { name = hit.name ?? name; categoryId = hit.categoryId ?? categoryId; }
      }
      return { ...base, name, categoryId, promptDetail: !!r.promptDetail, confidence: 'high' };
    }
  }
  // No rule matched — best-effort name, must be reviewed.
  const guess = (item.merchant || '').trim() || titleCase(norm) || desc.slice(0, 24) || 'Unknown';
  return { ...base, name: guess, categoryId: 28, promptDetail: true, confidence: 'low' };
}

// ── Firestore IO ──────────────────────────────────────────────────────────────
function importQueueRef() {
  return collection(firestore, 'users', auth.currentUser.uid, 'importQueue');
}
function bankMetaRef() {
  return doc(firestore, 'users', auth.currentUser.uid, 'meta', 'bankConnection');
}

export async function getBankMeta() {
  if (!auth.currentUser) return null;
  try {
    const snap = await getDocs(query(collection(firestore, 'users', auth.currentUser.uid, 'meta')));
    const row = snap.docs.find(d => d.id === 'bankConnection');
    return row ? row.data() : null;
  } catch { return null; }
}

// Set the go-live cutoff (transactions on/before this date are never imported).
export async function setImportCutoff(dateIso) {
  if (!auth.currentUser) return;
  await setDoc(bankMetaRef(), { importCutoffDate: dateIso }, { merge: true });
}

// Does a manually-entered transaction already look like this bank row? Same
// (rounded) amount within a day either side, not itself an imported row.
export async function findPossibleDuplicate(item) {
  const amt = Math.round(Math.abs(Number(item.amount) || 0) * 100);
  if (!amt || !item.date) return false;
  const d = item.date;
  const from = shiftDate(d, -1), to = shiftDate(d, 1);
  const near = await db.transactions.where('date').between(from, to, true, true).toArray();
  return near.some(t => t.source !== 'truelayer'
    && Math.round(Math.abs(Number(t.amount) || 0) * 100) === amt);
}

function shiftDate(iso, days) {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

export async function fetchPending() {
  if (!auth.currentUser) return [];
  const snap = await getDocs(query(importQueueRef(), where('status', '==', 'pending')));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

// The go-live cutoff: transactions on/before it are never offered.
export function cutoffFrom(meta) {
  return meta?.importCutoffDate || (meta?.connectedAt ? String(meta.connectedAt).slice(0, 10) : null);
}

// Pending rows that are actually reviewable (after the cutoff). This is the
// single source of truth for the badge, the review screen and auto-accept, so
// they can never disagree about what's outstanding.
export async function fetchReviewable() {
  const [meta, pending] = await Promise.all([getBankMeta(), fetchPending()]);
  const cutoff = cutoffFrom(meta);
  const items = cutoff ? pending.filter(i => (i.date || '') > cutoff) : pending;
  return { meta, cutoff, items, hidden: pending.length - items.length };
}

// Ask the secure trigger (Cloudflare Worker) to run the bank pull now. The
// Worker verifies this user's Firebase login before touching GitHub, so no
// secret ever lives in the app.
export async function requestBankPullNow() {
  const url = await getSetting('bankPullUrl');
  if (!url) throw new Error('No pull endpoint set');
  if (!auth.currentUser) throw new Error('Not signed in');
  const idToken = await auth.currentUser.getIdToken();
  const res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${idToken}` } });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { msg = (await res.json()).error || msg; } catch {}
    throw new Error(msg);
  }
  return true;
}

async function markImport(id, status, extra = {}) {
  if (!auth.currentUser) return;
  await setDoc(doc(firestore, 'users', auth.currentUser.uid, 'importQueue', String(id)),
    { status, actionedAt: new Date().toISOString(), ...extra }, { merge: true });
}

// ── Learned rules ─────────────────────────────────────────────────────────────
export async function loadLearnedRules() {
  try { return await db.merchantRules.toArray(); } catch { return []; }
}

export async function upsertLearnedRule(token, { name, categoryId }) {
  if (!token) return;
  const existing = await db.merchantRules.where('token').equals(token).first();
  if (existing) {
    await db.merchantRules.update(existing.id, { name, categoryId, hits: (existing.hits || 0) + 1 });
    queueWrite('merchantRules', existing.id).catch(() => {});
  } else {
    const id = await db.merchantRules.add({ token, name, categoryId, hits: 1, createdAt: new Date().toISOString() });
    queueWrite('merchantRules', id).catch(() => {});
  }
}

// Amount + cleaned-merchant fingerprint, used to reconcile a pending import with
// its later booked version (and to catch same-status duplicates). Prefer the
// tidier merchant_name; fall back to the raw descriptor.
export function fingerprintFor(item) {
  const pence = Math.round(Math.abs(Number(item.amount) || 0) * 100);
  const tok = normaliseDescriptor(item.merchant || item.description || '')
    .split(' ').filter(Boolean).slice(0, 2).join(' ');
  return `${pence}:${tok}`;
}

// ── Creating the transaction ──────────────────────────────────────────────────
// Idempotent and pending-aware:
//   • same bank id already imported            -> skip
//   • booked row matches an imported pending    -> upgrade the pending in place
//   • same fingerprint + same bank status       -> skip (re-seen pending / dup)
export async function confirmImport(item, { name, categoryId, note }) {
  const raw = Number(item.amount) || 0;
  const isDebit = (item.bankType || '').toUpperCase() === 'DEBIT' || raw < 0;
  const signedAmount = isDebit ? -Math.abs(raw) : Math.abs(raw);
  const bankStatus = item.bankStatus || 'booked';
  const bankId = item.bankTransactionId ? String(item.bankTransactionId) : null;
  const fp = fingerprintFor(item);
  const now = new Date().toISOString();

  if (bankId) {
    const byId = await db.transactions.where('bankTransactionId').equals(bankId).count();
    if (byId > 0) { await markImport(item.id, 'imported', { note: 'already existed' }); return null; }
  }

  const fpMatches = fp ? await db.transactions.where('bankFingerprint').equals(fp).toArray() : [];
  if (fpMatches.length) {
    const pendingMatch = fpMatches.find(t => t.bankStatus === 'pending');
    if (bankStatus === 'booked' && pendingMatch) {
      // The pending charge has settled — update the existing transaction with the
      // final amount/date/id rather than creating a second one. Keep the user's
      // category and note.
      await db.transactions.update(pendingMatch.id, {
        amount: signedAmount, date: item.date, bankTransactionId: bankId,
        bankFingerprint: fp, bankStatus: 'booked', updatedAt: now,
      });
      queueWrite('transactions', pendingMatch.id).catch(() => {});
      await markImport(item.id, 'imported', { importedTxId: pendingMatch.id, reconciled: true });
      return pendingMatch.id;
    }
    if (fpMatches.some(t => (t.bankStatus || 'booked') === bankStatus)) {
      await markImport(item.id, 'imported', { note: 'duplicate fingerprint' });
      return null;
    }
  }

  const txn = {
    date: item.date, amount: signedAmount, categoryId,
    note: (note != null ? note : name || '').trim(),
    type: isDebit ? 'expense' : 'income', distributionId: null,
    bankTransactionId: bankId, bankFingerprint: fp, bankStatus, source: 'truelayer',
    createdAt: now, updatedAt: now, syncStatus: 'pending',
  };
  const txId = await db.transactions.add(txn);
  queueWrite('transactions', txId).catch(() => {});
  await markImport(item.id, 'imported', { importedTxId: txId });
  return txId;
}

export async function ignoreImport(id) {
  await markImport(id, 'ignored');
}

// ── Auto-accept pass ──────────────────────────────────────────────────────────
// Import every fully-known item (high confidence, no note needed) automatically.
// Returns the number accepted. Items needing review are left in the queue.
export async function processAutoAccepts(pending, learnedRules, cutoff = null) {
  let accepted = 0;
  for (const item of pending) {
    if (cutoff && item.date && item.date <= cutoff) continue;   // pre go-live
    const p = proposeForItem(item, learnedRules);
    if (p.confidence !== 'high' || p.promptDetail) continue;     // needs review
    if (await findPossibleDuplicate(item)) continue;             // looks manual
    await confirmImport(item, { name: p.name, categoryId: p.categoryId });
    accepted++;
  }
  return accepted;
}

export async function isAutoAcceptOn() {
  return (await getSetting('bankAutoAccept')) === true;
}
