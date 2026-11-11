// Who is signed in, via Cloudflare Access (the same way agora does it).
//
// Access sits in front of /login and /api/account/* only, so anonymous use of
// the editor never meets it. On those paths Access authenticates at the edge
// and forwards a signed JWT in Cf-Access-Jwt-Assertion. A header proves
// nothing by itself, so the signature, issuer, audience and expiry are checked
// here against the team's published keys.
//
// FAILS CLOSED: with ACCESS_TEAM_DOMAIN or ACCESS_AUD unset, nobody is signed
// in and the account routes answer 503 (the page then hides Sign in).
// GORGON_DEV_USER=<email> stands in for Access under `wrangler dev` only; it
// is never in wrangler.jsonc, so it cannot ship by accident.

const b64urlToBytes = (s) => {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
const b64urlToJson = (s) => JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));

// Access rotates its keys: cache per isolate, refetch on an unknown kid.
let keyCache = { domain: null, at: 0, keys: new Map() };
const KEY_TTL_MS = 3600_000;

async function keyFor(teamDomain, kid) {
  const fresh = keyCache.domain === teamDomain && Date.now() - keyCache.at < KEY_TTL_MS;
  if (fresh && keyCache.keys.has(kid)) return keyCache.keys.get(kid);
  const url = `https://${teamDomain}/cdn-cgi/access/certs`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Access certs unavailable: ${res.status} for ${url}`);
  const { keys } = await res.json();
  const map = new Map();
  for (const jwk of keys || []) {
    map.set(jwk.kid, await crypto.subtle.importKey(
      'jwk',
      { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    ));
  }
  keyCache = { domain: teamDomain, at: Date.now(), keys: map };
  return map.get(kid);
}

/** Verify an Access JWT. Returns its claims, or throws. */
export async function verifyAccessJwt(token, { teamDomain, aud }) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed token');
  const [rawHeader, rawPayload, rawSig] = parts;
  const header = b64urlToJson(rawHeader);
  if (header.alg !== 'RS256') throw new Error(`unexpected alg ${header.alg}`);
  const key = await keyFor(teamDomain, header.kid);
  if (!key) throw new Error('unknown signing key');
  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5', key, b64urlToBytes(rawSig),
    new TextEncoder().encode(`${rawHeader}.${rawPayload}`),
  );
  if (!ok) throw new Error('bad signature');
  const claims = b64urlToJson(rawPayload);
  const now = Math.floor(Date.now() / 1000);
  if (claims.exp && claims.exp < now) throw new Error('token expired');
  if (claims.nbf && claims.nbf > now) throw new Error('token not yet valid');
  if (claims.iss && claims.iss !== `https://${teamDomain}`) throw new Error('wrong issuer');
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audience.includes(aud)) throw new Error('wrong audience');
  return claims;
}

/** Is sign-in set up on this deployment at all? */
export const accessConfigured = (env) =>
  !!(env.GORGON_DEV_USER || (env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD));

/**
 * The signed-in account, lower-cased email, or null.
 * Throws nothing: a bad or missing token is simply nobody.
 */
export async function identity(request, env) {
  if (env.GORGON_DEV_USER) return String(env.GORGON_DEV_USER).trim().toLowerCase();
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return null;
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) return null;
  try {
    const claims = await verifyAccessJwt(token, { teamDomain: env.ACCESS_TEAM_DOMAIN, aud: env.ACCESS_AUD });
    const who = claims.email || claims.sub;
    return who ? String(who).trim().toLowerCase() : null;
  } catch {
    return null;
  }
}
