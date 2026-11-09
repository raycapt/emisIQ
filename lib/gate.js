/**
 * Hosted-deployment gate, the same rules the Cloudflare Worker enforced:
 *
 *  - The app and its API need a valid Cloudflare Access session (the JWT is
 *    verified here, not just trusted), issued for this application, for an
 *    email on the allow-list. Access at the edge is the first lock; this is
 *    the second, so a mis-routed tunnel can never expose the app.
 *  - MCP authenticates with a bearer token in the path (/mcp/<token>), because
 *    an MCP client cannot complete a browser sign-in. On the dedicated MCP
 *    hostname nothing but /mcp is served.
 *
 * Everything is off unless ACCESS_TEAM_DOMAIN is set, so local use is unchanged.
 */

const CERT_TTL = 3600_000;
let jwks = { keys: null, at: 0, team: null };

export function gateFromEnv(env = process.env) {
  if (!env.ACCESS_TEAM_DOMAIN) return null;
  return {
    team: env.ACCESS_TEAM_DOMAIN,
    aud: env.ACCESS_AUD || null,
    allowed: String(env.ACCESS_ALLOWED_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean),
    mcpToken: env.MCP_TOKEN || null,
    mcpHost: env.MCP_HOSTNAME || null,
  };
}

export function tokenMatches(given, expected) {
  if (!given || !expected || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

/** The token from /mcp/<token>[/...]. */
export const mcpTokenFrom = (pathname) => pathname.slice('/mcp/'.length).split('/')[0];

const bytes = (s) => {
  const p = s.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(p + '='.repeat((4 - (p.length % 4)) % 4)), (c) => c.charCodeAt(0));
};
const json = (s) => JSON.parse(new TextDecoder().decode(bytes(s)));

async function keysFor(team) {
  if (jwks.keys && jwks.team === team && Date.now() - jwks.at < CERT_TTL) return jwks.keys;
  const res = await fetch(`https://${team}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`certs ${res.status}`);
  const body = await res.json();
  jwks = { keys: body.keys || [], at: Date.now(), team };
  return jwks.keys;
}

/** headers: a Node IncomingHttpHeaders object. */
export async function verifyAccess(headers, gate) {
  if (!gate.allowed.length) return { ok: false, status: 503, reason: 'access policy not configured' };
  const cookie = String(headers.cookie || '');
  const token = headers['cf-access-jwt-assertion'] || cookie.match(/(?:^|;\s*)CF_Authorization=([^;]+)/)?.[1];
  if (!token) return { ok: false, status: 401, reason: 'no Cloudflare Access session' };

  const parts = String(token).split('.');
  if (parts.length !== 3) return { ok: false, status: 403, reason: 'malformed token' };
  let header, payload;
  try {
    header = json(parts[0]);
    payload = json(parts[1]);
  } catch {
    return { ok: false, status: 403, reason: 'malformed token' };
  }

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < now) return { ok: false, status: 401, reason: 'session expired' };
  if (payload.iss !== `https://${gate.team}`) return { ok: false, status: 403, reason: 'wrong issuer' };
  if (gate.aud) {
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.includes(gate.aud)) return { ok: false, status: 403, reason: 'token issued for another application' };
  }
  const email = String(payload.email || '').toLowerCase();
  if (!gate.allowed.includes(email)) return { ok: false, status: 403, reason: 'this sign-in is not on the allow-list' };

  let keys;
  try {
    keys = await keysFor(gate.team);
  } catch (err) {
    return { ok: false, status: 503, reason: `could not fetch signing keys (${err.message})` };
  }
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) return { ok: false, status: 403, reason: 'unknown signing key' };
  const key = await crypto.subtle.importKey(
    'jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'],
  );
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5', key, bytes(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  return valid ? { ok: true, email } : { ok: false, status: 403, reason: 'bad signature' };
}
