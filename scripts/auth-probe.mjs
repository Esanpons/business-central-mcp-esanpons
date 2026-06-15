// Standalone auth probe: learn the REAL Set-Cookie scope (path / Secure / SameSite / HttpOnly)
// that devel1 issues, and confirm the /SignIn forms-auth flow. No imports from src/.
// Run: node scripts/auth-probe.mjs
import { load } from 'cheerio';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const BASE = (process.env.BC_BASE_URL || '').replace(/\/+$/, '');
const USER = process.env.BC_USERNAME || '';
const PASS = process.env.BC_PASSWORD || '';
const TENANT = process.env.BC_TENANT_ID || 'default';
if (!BASE || !USER || !PASS) { console.error('Set BC_BASE_URL, BC_USERNAME, BC_PASSWORD env vars.'); process.exit(1); }
const signInUrl = `${BASE}/SignIn?tenant=${encodeURIComponent(TENANT)}`;

function cookieHeaderFrom(setCookies) {
  // name=value pairs only (what bc-mcp stores)
  return setCookies.map((c) => c.split(';')[0]).join('; ');
}

const out = { signInUrl, steps: {} };

// Step 1: GET the login form
const getRes = await fetch(signInUrl, {
  method: 'GET',
  redirect: 'manual',
  headers: { 'User-Agent': 'Mozilla/5.0 bc-mcp-probe' },
});
const getCookies = getRes.headers.getSetCookie();
const html = await getRes.text();
const $ = load(html);
const token = $('input[name="__RequestVerificationToken"]').attr('value') || '';
out.steps.get = {
  status: getRes.status,
  rawSetCookie: getCookies,
  tokenFound: token ? token.slice(0, 12) + '...' : null,
  formFieldNames: $('form input').map((_, el) => $(el).attr('name')).get(),
  formAction: $('form').attr('action'),
};

// Step 2: POST credentials
const body = new URLSearchParams();
body.set('UserName', USER);
body.set('Password', PASS);
body.set('__RequestVerificationToken', token);

const postRes = await fetch(signInUrl, {
  method: 'POST',
  redirect: 'manual',
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded',
    'User-Agent': 'Mozilla/5.0 bc-mcp-probe',
    Cookie: cookieHeaderFrom(getCookies),
  },
  body: body.toString(),
});
const postCookies = postRes.headers.getSetCookie();
out.steps.post = {
  status: postRes.status, // 302 == authenticated, 200 == login form re-rendered (auth failed)
  location: postRes.headers.get('location'),
  rawSetCookie: postCookies,
  authenticated: postRes.status === 302,
};

// Step 3: follow to the app root with the merged jar, confirm we are NOT bounced to SignIn
const mergedNames = new Map();
for (const c of [...getCookies, ...postCookies]) {
  const nv = c.split(';')[0];
  const eq = nv.indexOf('=');
  if (eq > 0) mergedNames.set(nv.slice(0, eq), nv);
}
const mergedJar = [...mergedNames.values()].join('; ');
const rootRes = await fetch(`${BASE}/?tenant=${TENANT}`, {
  method: 'GET',
  redirect: 'manual',
  headers: { 'User-Agent': 'Mozilla/5.0 bc-mcp-probe', Cookie: mergedJar },
});
out.steps.appRoot = {
  status: rootRes.status,
  location: rootRes.headers.get('location'),
  bouncedToSignIn: (rootRes.headers.get('location') || '').includes('SignIn'),
};
out.mergedJarNames = [...mergedNames.keys()];

console.log(JSON.stringify(out, null, 2));
