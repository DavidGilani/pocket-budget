// Cloudflare Worker: secure "Pull from bank now" trigger for Pocket Ledger.
//
// The app never holds a GitHub token. Instead it sends the signed-in user's
// Firebase ID token here; this Worker verifies that token against Google's
// public keys, checks the email is the allowed owner, and only then asks
// GitHub to run the "Bank sync" workflow (workflow_dispatch).
//
// Deploy via the Cloudflare dashboard (no terminal needed) and set these in
// Settings > Variables and Secrets:
//   GITHUB_TOKEN         (secret)  fine-grained PAT: this repo only, Actions: Read and write
//   ALLOWED_EMAIL        (var)     the Google account allowed to trigger pulls
//   FIREBASE_PROJECT_ID  (var)     e.g. pocket-budget-d42a7
//   GITHUB_REPO          (var)     e.g. DavidGilani/pocket-budget
//   ALLOWED_ORIGIN       (var)     e.g. https://davidgilani.github.io

const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';

function b64urlToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  s += '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(s);
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}
const decodeJson = seg => JSON.parse(new TextDecoder().decode(b64urlToBytes(seg)));

// Verify a Firebase ID token (RS256, signed by Google's securetoken keys).
async function verifyFirebaseToken(idToken, projectId) {
  const [h, p, s] = idToken.split('.');
  if (!h || !p || !s) throw new Error('malformed token');
  const header = decodeJson(h), payload = decodeJson(p);
  if (header.alg !== 'RS256') throw new Error('unexpected alg');
  const now = Math.floor(Date.now() / 1000);
  if (!payload.exp || payload.exp <= now) throw new Error('expired');
  if (payload.aud !== projectId) throw new Error('wrong audience');
  if (payload.iss !== `https://securetoken.google.com/${projectId}`) throw new Error('wrong issuer');
  if (!payload.sub) throw new Error('no subject');

  const jwks = await (await fetch(JWKS_URL, { cf: { cacheTtl: 3600, cacheEverything: true } })).json();
  const jwk = (jwks.keys || []).find(k => k.kid === header.kid);
  if (!jwk) throw new Error('unknown signing key');
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlToBytes(s), new TextEncoder().encode(`${h}.${p}`));
  if (!ok) throw new Error('bad signature');
  return payload;
}

const cors = (env, extra = {}) => ({
  'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  ...extra,
});
const json = (obj, status, env) =>
  new Response(JSON.stringify(obj), { status, headers: cors(env, { 'Content-Type': 'application/json' }) });

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(env) });
    if (request.method !== 'POST') return json({ error: 'POST only' }, 405, env);

    const authz = request.headers.get('Authorization') || '';
    const token = authz.startsWith('Bearer ') ? authz.slice(7) : '';
    if (!token) return json({ error: 'missing token' }, 401, env);

    let payload;
    try { payload = await verifyFirebaseToken(token, env.FIREBASE_PROJECT_ID); }
    catch (e) { return json({ error: `invalid token (${e.message})` }, 401, env); }

    const email = String(payload.email || '').toLowerCase();
    if (!payload.email_verified || email !== String(env.ALLOWED_EMAIL || '').toLowerCase()) {
      return json({ error: 'not allowed' }, 403, env);
    }

    const url = `https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/bank-sync.yml/dispatches`;
    const gh = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'pocket-ledger-bank-pull',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ref: 'main' }),
    });
    if (gh.status === 204) return json({ ok: true }, 200, env);
    const detail = (await gh.text()).slice(0, 200);
    return json({ error: `github ${gh.status}`, detail }, 502, env);
  },
};
