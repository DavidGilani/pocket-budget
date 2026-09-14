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

// 2. Cards on this consent.
const cards = (await api('/data/v1/cards')).results || [];

// 3. Transactions per card -> import queue.
const queue = ref.collection('importQueue');
let seen = 0, queued = 0;

for (const card of cards) {
  const txns = (await api(`/data/v1/cards/${card.account_id}/transactions`)).results || [];
  for (const t of txns) {
    seen++;
    const id = t.transaction_id || t.normalised_provider_transaction_id;
    if (!id) continue;
    try {
      await queue.doc(String(id)).create({
        bankTransactionId: String(id),
        date: (t.timestamp || '').slice(0, 10),
        amount: typeof t.amount === 'number' ? t.amount : Number(t.amount) || 0,
        currency: t.currency || 'GBP',
        description: t.description || '',
        merchant: t.merchant_name || '',
        bankType: t.transaction_type || '',        // DEBIT / CREDIT
        bankCategory: t.transaction_category || '', // TrueLayer's category hint
        cardId: card.account_id,
        source: 'truelayer',
        status: 'pending',
        createdAt: new Date().toISOString(),
      });
      queued++;
    } catch (e) {
      // create() throws ALREADY_EXISTS for rows we've already queued or actioned
      // — that's the dedupe, so swallow it. Re-throw anything else.
      if (!(e && (e.code === 6 || String(e.message).includes('ALREADY_EXISTS')))) throw e;
    }
  }
}

await connDoc.set({ lastSyncAt: new Date().toISOString(), needsReconsent: false, lastError: null }, { merge: true });
console.log(`Sync complete (${TL.env}). Cards: ${cards.length}; transactions seen: ${seen}; newly queued: ${queued}.`);
