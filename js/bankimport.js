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

// Cost or income? The bank's transaction_type is authoritative: DEBIT is a
// cost, CREDIT (a refund or payment) is income. Only fall back to the amount
// sign when the type is missing — on a credit card the sign alone is ambiguous.
export function deriveIsDebit(item) {
  const type = (item.bankType || '').toUpperCase();
  if (type === 'DEBIT') return true;
  if (type === 'CREDIT') return false;
  return (Number(item.amount) || 0) < 0;
}

// ── Proposal ──────────────────────────────────────────────────────────────────
// Given a queue item and the learned rules, return the suggested name, category,
// whether it needs a note, a confidence level, and the derived amount fields.
export function proposeForItem(item, learnedRules = []) {
  const raw = Number(item.amount) || 0;
  const isDebit = deriveIsDebit(item);
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

// How long a pending card charge can take to settle into its booked version.
const SETTLE_WINDOW_DAYS = 7;

function daysApart(a, b) {
  if (!a || !b) return Infinity;
  return Math.abs((new Date(a + 'T12:00:00') - new Date(b + 'T12:00:00')) / 86400000);
}

const pence = v => Math.round(Math.abs(Number(v) || 0) * 100);

// Find the imported PENDING record this booked row is the settlement of: same
// amount, still marked pending, and dated up to a week BEFORE the booked row (a
// charge is authorised first, then settles — never the other way round; one day
// of slack allows for timestamp quirks). A fingerprint (amount + merchant) match
// is preferred, else amount alone, covering merchant text that drifts between
// pending and booked. Closest date wins. Looks at single transactions and at
// distributions created from a pending import.
async function findPendingTwin(item) {
  const amt = pence(item.amount);
  if (!amt || !item.date) return null;
  const from = shiftDate(item.date, -SETTLE_WINDOW_DAYS), to = shiftDate(item.date, 1);
  const fp = fingerprintFor(item);
  const byClosest = (a, b) => daysApart(a.date, item.date) - daysApart(b.date, item.date);
  const pick = list => list.filter(r => r.bankFingerprint === fp).sort(byClosest)[0] || list.sort(byClosest)[0];

  const txns = (await db.transactions.where('date').between(from, to, true, true).toArray())
    .filter(t => t.bankStatus === 'pending' && pence(t.amount) === amt);
  if (txns.length) return { table: 'transactions', row: pick(txns) };

  const dists = (await db.distributions.where('startDate').between(from, to, true, true).toArray())
    .filter(d => d.bankStatus === 'pending' && pence(d.totalAmount) === amt)
    .map(d => ({ ...d, date: d.startDate }));
  if (dists.length) return { table: 'distributions', row: pick(dists) };
  return null;
}

// Is this booked row the settled version of an already-imported pending one?
export async function hasPendingTwin(item) {
  return !!(await findPendingTwin(item));
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
  const [meta, pending, ignoreRules, learned] = await Promise.all([
    getBankMeta(), fetchPending(), loadIgnoreRules(), loadLearnedRules(),
  ]);
  const cutoff = cutoffFrom(meta);
  const afterCutoff = cutoff ? pending.filter(i => (i.date || '') > cutoff) : pending;

  // Auto-settle duplicates: a booked row that is the settled version of an
  // already-imported PENDING transaction (same amount + date, previously
  // pending) is reconciled in place and never shown — regardless of the
  // auto-accept setting or the merchant being "needs detail".
  const settled = new Set();
  for (const it of afterCutoff) {
    if ((it.bankStatus || 'booked') === 'booked' && await hasPendingTwin(it)) {
      await confirmImport(it, proposeForItem(it, learned)); // reconcile branch
      settled.add(it.id);
    }
  }

  let items = afterCutoff.filter(i => !settled.has(i.id));
  if (ignoreRules.length) {
    items = items.filter(i => {
      const norm = normaliseDescriptor(i.merchant || i.description || '');
      return !ignoreRules.some(r => r.token && norm.includes(r.token));
    });
  }
  // `hidden` reflects only pre-cutoff rows (used for the "older transactions
  // hidden" note); ignored/settled rows are silently dropped.
  return { meta, cutoff, items, hidden: pending.length - afterCutoff.length };
}

// Mark a queue row as imported (used when a distribution is created from an
// import, which bypasses confirmImport).
export async function markImported(id, importedTxId) {
  await markImport(id, 'imported', importedTxId != null ? { importedTxId } : {});
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
  try { return (await db.merchantRules.toArray()).filter(r => !r.ignore); } catch { return []; }
}

export async function loadIgnoreRules() {
  try { return (await db.merchantRules.toArray()).filter(r => r.ignore); } catch { return []; }
}

// Remember a merchant to always auto-ignore (future charges never surface).
export async function addIgnoreRule(token, label) {
  if (!token) return;
  const existing = await db.merchantRules.where('token').equals(token).first();
  if (existing) {
    await db.merchantRules.update(existing.id, { ignore: true, name: label || existing.name });
    queueWrite('merchantRules', existing.id).catch(() => {});
  } else {
    const id = await db.merchantRules.add({ token, ignore: true, name: label || '', createdAt: new Date().toISOString() });
    queueWrite('merchantRules', id).catch(() => {});
  }
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
//   • same bank id already imported                          -> skip
//   • booked row settles an imported pending (≤ 7 days)      -> upgrade in place
//   • pending row = same merchant/amount/day already logged  -> skip (re-seen)
//   • anything else (incl. a 2nd same-amount pending)        -> new transaction
export async function confirmImport(item, { name, categoryId, note, type, date }) {
  const raw = Number(item.amount) || 0;
  // Honour an explicit cost/income override from the review card; otherwise
  // classify from the bank's transaction type.
  const isDebit = type ? (type === 'expense') : deriveIsDebit(item);
  const signedAmount = isDebit ? -Math.abs(raw) : Math.abs(raw);
  const bankStatus = item.bankStatus || 'booked';
  const bankId = item.bankTransactionId ? String(item.bankTransactionId) : null;
  const fp = fingerprintFor(item);
  const now = new Date().toISOString();

  if (bankId) {
    const byId = await db.transactions.where('bankTransactionId').equals(bankId).count();
    if (byId > 0) { await markImport(item.id, 'imported', { note: 'already existed' }); return null; }
  }

  if (bankStatus === 'booked') {
    // A booked charge that settles a pending one we already imported (same
    // amount, pending dated up to a week earlier) is the SAME spend: upgrade
    // that record in place rather than creating a second one.
    const twin = await findPendingTwin(item);
    if (twin?.table === 'transactions') {
      const pendingMatch = twin.row;
      // Keep the user's category and note, and the EARLIER date — the pending
      // row carries the day the spend was made; the booked date is often the
      // later day it settled.
      const spendDate = [pendingMatch.date, item.date].filter(Boolean).sort()[0] || item.date;
      await db.transactions.update(pendingMatch.id, {
        amount: signedAmount, date: spendDate, bankTransactionId: bankId,
        bankFingerprint: fp, bankStatus: 'booked', updatedAt: now,
      });
      queueWrite('transactions', pendingMatch.id).catch(() => {});
      await markImport(item.id, 'imported', { importedTxId: pendingMatch.id, reconciled: true });
      return pendingMatch.id;
    }
    if (twin?.table === 'distributions') {
      // The pending charge was spread as a big expense — just mark it settled.
      await db.distributions.update(twin.row.id, { bankTransactionId: bankId, bankStatus: 'booked' });
      queueWrite('distributions', twin.row.id).catch(() => {});
      await markImport(item.id, 'imported', { reconciled: true, distributionId: twin.row.id });
      return null;
    }
    // No pending twin: a distinct booked charge (re-seen booked rows are already
    // caught by the bank-id check above), so fall through and create it.
  } else {
    // A PENDING charge is a new spend unless it's literally the same charge seen
    // again (same merchant, same amount, same day — e.g. re-fetched under a new
    // id). A second pending charge on another day, even for an identical amount,
    // is a genuine second spend and must come through.
    const sameCharge = fp ? (await db.transactions.where('bankFingerprint').equals(fp).toArray())
      .some(t => t.date === item.date) : false;
    if (sameCharge) {
      await markImport(item.id, 'imported', { note: 'same pending charge re-seen' });
      return null;
    }
  }

  const txn = {
    date: date || item.date, amount: signedAmount, categoryId,
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
