// Shared helpers for the TrueLayer -> Firestore importer.
//
// Runs ONLY in GitHub Actions (Node 20). All secrets arrive as environment
// variables sourced from GitHub Actions secrets — nothing is hard-coded and
// nothing sensitive is ever written to the repo or the Action logs.
//
// Env vars expected:
//   TL_ENV                   'live' (default) or 'sandbox'
//   TL_CLIENT_ID             TrueLayer client id (for the chosen environment)
//   TL_CLIENT_SECRET         TrueLayer client secret (same environment)
//   TL_REDIRECT_URI          registered redirect URI (connect step only)
//   FIREBASE_SERVICE_ACCOUNT the full service-account JSON, as a string
//   FIREBASE_UID             the Firebase Auth uid whose data we write to

import admin from 'firebase-admin';

export const TL = (() => {
  const env = (process.env.TL_ENV || 'live').toLowerCase();
  const sandbox = env === 'sandbox';
  return {
    env,
    authBase: sandbox ? 'https://auth.truelayer-sandbox.com' : 'https://auth.truelayer.com',
    apiBase: sandbox ? 'https://api.truelayer-sandbox.com' : 'https://api.truelayer.com',
  };
})();

export function db() {
  if (!admin.apps.length) {
    if (!process.env.FIREBASE_SERVICE_ACCOUNT) throw new Error('FIREBASE_SERVICE_ACCOUNT not set');
    const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({ credential: admin.credential.cert(sa) });
  }
  return admin.firestore();
}

// The user document that mirrors what the app reads (users/<uid>/...).
export function userRef() {
  const uid = process.env.FIREBASE_UID;
  if (!uid) throw new Error('FIREBASE_UID not set');
  return db().collection('users').doc(uid);
}

// POST to TrueLayer's token endpoint. `params` supplies grant_type and the
// grant-specific fields (code / refresh_token). Returns the parsed JSON.
export async function tokenRequest(params) {
  const body = new URLSearchParams({
    client_id: process.env.TL_CLIENT_ID,
    client_secret: process.env.TL_CLIENT_SECRET,
    ...params,
  });
  const res = await fetch(`${TL.authBase}/connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const text = await res.text();
  if (!res.ok) {
    // Never print the body verbatim beyond a short, non-sensitive slice.
    throw new Error(`Token request failed (${res.status}): ${text.slice(0, 160)}`);
  }
  return JSON.parse(text);
}
