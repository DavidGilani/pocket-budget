// Nightly sync: refresh -> fetch card transactions -> queue for review.
//
// Reads the stored refresh token, gets a fresh access token, pulls transactions
// for every card on the connected consent, and writes any not-seen-before ones
// into users/<uid>/importQueue with status 'pending'. The app then shows those
// for review and, on confirm, turns them into real transactions.
//
// Privacy: only counts are logged, never transaction contents. Deduplication is
// by TrueLayer's stable transaction id (the Firestore doc id), and we use
// create() so a row the app has already actioned is never overwritten.

import { tokenRequest, userRef, TL } from './lib.mjs';

const ref = userRef();
const connDoc = ref.collection('meta').doc('bankConnection');
const conn = await connDoc.get();
if (!conn.exists || !conn.data().refreshToken) {
  console.error('No bank connection found. Run "Bank connect" first.');
  process.exit(1);
}

// 1. Refresh -> access token. TrueLayer may rotate the refresh token; persist it.
const tok = await tokenRequest({
  grant_type: 'refresh_token',
  refresh_token: conn.data().refreshToken,
});
const accessToken = tok.access_token;
if (tok.refresh_token && tok.refresh_token !== conn.data().refreshToken) {
  await connDoc.set({ refreshToken: tok.refresh_token }, { merge: true });
}

async function api(path) {
  const res = await fetch(`${TL.apiBase}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.status === 401 || res.status === 403) {
    // Consent has most likely expired (the ~90-day SCA window). Flag it so the
    // app can prompt a reconnect, then stop.
    await connDoc.set({ needsReconsent: true, lastError: res.status, lastErrorAt: new Date().toISOString() }, { merge: true });
    throw new Error(`Access denied (${res.status}). Consent likely expired — reconnect the bank.`);
  }
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
  return res.json();
}

// Go-live cutoff: import only transactions dated after this, so anything
// already logged manually before go-live is never re-created.
const cutoff = conn.data().importCutoffDate
  || (conn.data().connectedAt ? conn.data().connectedAt.slice(0, 10) : '0000-00-00');

// A light fingerprint (amount + first words of the descriptor) used to give
// pending rows a stable id and to match a pending row to its booked version.
function fingerprint(t) {
  const pence = Math.round(Math.abs(Number(t.amount) || 0) * 100);
  const tok = (t.description || t.merchant_name || '')
    .toLowerCase().replace(/[^a-z]+/g, ' ').trim().split(' ').filter(Boolean).slice(0, 2).join(' ');
  return `${pence}:${tok}`;
}


// 2. Cards on this consent.
const cards = (await api('/data/v1/cards')).results || [];

// 3. Transactions per card -> import queue (booked, then pending).
const queue = ref.collection('importQueue');
let seen = 0, queued = 0, skippedPreCutoff = 0, pendingQueued = 0;
// Booked charges as {fingerprint, date}. A pending is only the same charge as a
// booked one if they share a fingerprint AND the booked one is dated on/after
// the pending (a charge is authorised, then settles) within a week. An older
// booked charge never swallows a newer pending one — that's a genuine second
// spend that happens to be the same amount.
const bookedTwins = [];
function bookedTwinNear(fp, date) {
  if (!date) return false;
  return bookedTwins.some(b => {
    if (b.fp !== fp || !b.date) return false;
    // Days from the pending to the booked one (+ve = booked is later). One day
    // of slack either side of "same day" allows for timestamp quirks.
    const diff = (new Date(b.date + 'T12:00:00') - new Date(date + 'T12:00:00')) / 86400000;
    return diff >= -1 && diff <= 7;
  });
}

async function queueOne(t, card, bankStatus) {
  const txDate = (t.timestamp || '').slice(0, 10);
  if (txDate && txDate <= cutoff) { skippedPreCutoff++; return; }
  const stableId = t.transaction_id || t.normalised_provider_transaction_id;
  // Pending rows without a stable id are keyed by fingerprint + date, so two
  // separate charges (same shop/amount, different days) don't collide on one id.
  const docId = bankStatus === 'pending'
    ? `p_${stableId || (fingerprint(t) + '_' + txDate)}`
    : (stableId ? String(stableId) : '');
  if (!docId || docId === 'p_') return;
  seen++;
  try {
    await queue.doc(docId).create({
      bankTransactionId: stableId ? String(stableId) : null,
      bankStatus,                                  // 'booked' or 'pending'
      fingerprint: fingerprint(t),
      date: txDate,
      amount: typeof t.amount === 'number' ? t.amount : Number(t.amount) || 0,
      currency: t.currency || 'GBP',
      description: t.description || '',
      merchant: t.merchant_name || '',
      bankType: t.transaction_type || '',          // DEBIT / CREDIT
      bankCategory: t.transaction_category || '',   // TrueLayer's category hint
      cardId: card.account_id,
      source: 'truelayer',
      status: 'pending',                            // review status (not bank status)
      createdAt: new Date().toISOString(),
    });
    queued++;
    if (bankStatus === 'pending') pendingQueued++;
  } catch (e) {
    if (!(e && (e.code === 6 || String(e.message).includes('ALREADY_EXISTS')))) throw e;
  }
}

for (const card of cards) {
  const booked = (await api(`/data/v1/cards/${card.account_id}/transactions`)).results || [];
  for (const t of booked) { bookedTwins.push({ fp: fingerprint(t), date: (t.timestamp || '').slice(0, 10) }); }
  for (const t of booked) { await queueOne(t, card, 'booked'); }

  // Pending transactions give near-real-time visibility. Not every provider
  // exposes them — ignore a plain not-available error, but let a consent
  // failure (401/403) propagate so the reconnect flag is set.
  let pending = [];
  try {
    pending = (await api(`/data/v1/cards/${card.account_id}/transactions/pending`)).results || [];
  } catch (e) {
    if (String(e.message).includes('Consent')) throw e;
  }
  for (const t of pending) {
    // Skip only if THIS pending charge has already settled into a nearby booked
    // one (same fingerprint, within a few days) — not just any old match.
    if (bookedTwinNear(fingerprint(t), (t.timestamp || '').slice(0, 10))) continue;
    await queueOne(t, card, 'pending');
  }
}

// Drop still-pending-review queue rows whose pending transaction has now
// settled (a booked row with the same fingerprint AND a nearby date exists), so
// it isn't offered twice. Only touches rows the app hasn't actioned yet.
let supersededPending = 0;
const pendingRows = await queue.where('status', '==', 'pending').get();
for (const d of pendingRows.docs) {
  const data = d.data();
  if (data.bankStatus === 'pending' && bookedTwinNear(data.fingerprint, data.date)) {
    await d.ref.delete(); supersededPending++;
  }
}

// Housekeeping: remove any still-pending queue rows dated on/before the cutoff.
// These can exist from an earlier run before the cutoff was introduced; they
// must never be offered for import (they'd duplicate manual pre-go-live entries).
let cleaned = 0;
const pending = await queue.where('status', '==', 'pending').get();
for (const d of pending.docs) {
  const dt = d.data().date || '';
  if (dt && dt <= cutoff) { await d.ref.delete(); cleaned++; }
}

await connDoc.set({ lastSyncAt: new Date().toISOString(), needsReconsent: false, lastError: null }, { merge: true });
console.log(`Sync complete (${TL.env}). Cards: ${cards.length}; seen: ${seen}; newly queued: ${queued} (pending: ${pendingQueued}); skipped pre-cutoff: ${skippedPreCutoff}; cleaned stale: ${cleaned}; superseded pending: ${supersededPending}.`);
