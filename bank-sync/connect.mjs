// One-time (and every-90-days) bank connect step.
//
// Takes a fresh TrueLayer authorization CODE (from the browser consent flow,
// read out of the redirect URL) and exchanges it for a long-lived refresh
// token, which is stored privately in Firestore. After this runs, the nightly
// sync can fetch transactions on its own until the ~90-day consent expires.
//
// Triggered manually from the GitHub Actions "Bank connect" workflow, which
// passes the code as the CODE env var.

import { tokenRequest, userRef, TL } from './lib.mjs';

const code = (process.env.CODE || '').trim();
if (!code) { console.error('No CODE provided.'); process.exit(1); }

const redirectUri = process.env.TL_REDIRECT_URI || 'https://console.truelayer.com/redirect-page';

const tok = await tokenRequest({
  grant_type: 'authorization_code',
  redirect_uri: redirectUri,
  code,
});

if (!tok.refresh_token) {
  throw new Error('Exchange succeeded but no refresh_token was returned (was "offline_access" in the auth scope?).');
}

await userRef().collection('meta').doc('bankConnection').set({
  refreshToken: tok.refresh_token,
  env: TL.env,
  connectedAt: new Date().toISOString(),
  needsReconsent: false,
  lastError: null,
}, { merge: true });

console.log(`Bank connected (${TL.env}). Refresh token stored securely in Firestore.`);
console.log('You can now run "Bank sync" to pull transactions.');
