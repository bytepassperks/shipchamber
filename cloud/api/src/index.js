// ShipChamber API Worker: license issuance/activation (D1), Dodo Payments
// webhook, update check, and the iOS push relay endpoint.

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };
const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization',
};

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...CORS_HEADERS, ...extra } });
const fail = (status, code, error) => json({ code, error }, status);

const KEY_PATTERN = /^SC-[A-Z0-9]{4}(?:-[A-Z0-9]{4}){3}$/;
// No 0/O/1/I to keep keys readable when typed from a receipt.
const KEY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const generateKey = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const chars = Array.from(bytes, (b) => KEY_ALPHABET[b % KEY_ALPHABET.length]);
  const groups = [];
  for (let i = 0; i < 16; i += 4) groups.push(chars.slice(i, i + 4).join(''));
  return `SC-${groups.join('-')}`;
};

const normalizeKey = (value) => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase().replace(/\s+/g, '');
  return KEY_PATTERN.test(normalized) ? normalized : null;
};

const readJson = async (request) => {
  try {
    const data = await request.json();
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
};

const installIdOf = (body) =>
  typeof body?.installId === 'string' && body.installId.length >= 8 && body.installId.length <= 128
    ? body.installId
    : null;

// ---------------------------------------------------------------------------
// Licenses

const findLicense = (env, key) =>
  env.DB.prepare('SELECT id, key, status FROM licenses WHERE key = ?').bind(key).first();

const licenseActivate = async (request, env) => {
  const body = await readJson(request);
  const key = normalizeKey(body?.key);
  const installId = installIdOf(body);
  if (!key || !installId) return fail(400, 'invalid_key', 'A license key and install id are required.');

  const license = await findLicense(env, key);
  if (!license) return fail(404, 'invalid', 'This license key was not found.');
  if (license.status !== 'active') return fail(403, 'revoked', 'This license has been revoked.');

  const now = Date.now();
  const existing = await env.DB.prepare(
    'SELECT install_id FROM activations WHERE license_id = ? AND install_id = ?',
  ).bind(license.id, installId).first();

  if (!existing) {
    const { count } = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM activations WHERE license_id = ?',
    ).bind(license.id).first();
    const max = Number(env.MAX_INSTALLS_PER_LICENSE) || 5;
    if (count >= max) {
      return fail(409, 'device_limit', `This license is already active on ${max} instances. Remove it from one of them first.`);
    }
    await env.DB.prepare(
      'INSERT INTO activations (license_id, install_id, activated_at, last_seen_at) VALUES (?, ?, ?, ?)',
    ).bind(license.id, installId, now, now).run();
  } else {
    await env.DB.prepare(
      'UPDATE activations SET last_seen_at = ? WHERE license_id = ? AND install_id = ?',
    ).bind(now, license.id, installId).run();
  }

  return json({ tier: 'lifetime', licenseId: license.id });
};

const licenseValidate = async (request, env) => {
  const body = await readJson(request);
  const key = normalizeKey(body?.key);
  const installId = installIdOf(body);
  if (!key || !installId) return fail(400, 'invalid_key', 'A license key and install id are required.');

  const license = await findLicense(env, key);
  if (!license) return fail(404, 'invalid', 'This license key was not found.');
  if (license.status !== 'active') return fail(403, 'revoked', 'This license has been revoked.');

  const activation = await env.DB.prepare(
    'SELECT install_id FROM activations WHERE license_id = ? AND install_id = ?',
  ).bind(license.id, installId).first();
  if (!activation) return fail(403, 'invalid', 'This license is not activated on this instance.');

  await env.DB.prepare(
    'UPDATE activations SET last_seen_at = ? WHERE license_id = ? AND install_id = ?',
  ).bind(Date.now(), license.id, installId).run();
  return json({ tier: 'lifetime', licenseId: license.id });
};

const licenseDeactivate = async (request, env) => {
  const body = await readJson(request);
  const key = normalizeKey(body?.key);
  const installId = installIdOf(body);
  if (!key || !installId) return fail(400, 'invalid_key', 'A license key and install id are required.');

  const license = await findLicense(env, key);
  if (license) {
    await env.DB.prepare('DELETE FROM activations WHERE license_id = ? AND install_id = ?')
      .bind(license.id, installId).run();
  }
  return json({ ok: true });
};

// After checkout Dodo redirects to the site with `payment_id`; the thank-you
// page calls this to show the key. Only the key for that exact payment is
// returned, and payment ids are unguessable.
const licenseClaim = async (request, env) => {
  const url = new URL(request.url);
  const paymentId = url.searchParams.get('payment_id');
  if (!paymentId || paymentId.length > 128) return fail(400, 'invalid', 'payment_id is required.');
  const row = await env.DB.prepare(
    'SELECT key, email, status FROM licenses WHERE payment_id = ?',
  ).bind(paymentId).first();
  if (!row) return fail(404, 'pending', 'We have not received this payment yet. Give it a few seconds and refresh.');
  return json({ key: row.key, email: row.email, status: row.status });
};

// ---------------------------------------------------------------------------
// Dodo Payments webhook (Standard Webhooks signature scheme)

const base64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const bytesToBase64 = (bytes) => btoa(String.fromCharCode(...bytes));

const verifyStandardWebhook = async ({ secret, id, timestamp, signatureHeader, body }) => {
  if (!secret || !id || !timestamp || !signatureHeader) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 5 * 60) return false;
  const rawSecret = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
  const keyBytes = base64ToBytes(rawSecret);
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${timestamp}.${body}`));
  const expected = bytesToBase64(new Uint8Array(mac));
  return signatureHeader.split(' ').some((part) => {
    const [version, sig] = part.split(',');
    return version === 'v1' && sig === expected;
  });
};

const issueLicenseForPayment = async (env, payment) => {
  const paymentId = payment.payment_id;
  const existing = await env.DB.prepare('SELECT key FROM licenses WHERE payment_id = ?').bind(paymentId).first();
  if (existing) return existing.key;

  const key = generateKey();
  const id = crypto.randomUUID();
  const productId = Array.isArray(payment.product_cart) ? payment.product_cart[0]?.product_id ?? null : null;
  await env.DB.prepare(
    'INSERT INTO licenses (id, key, email, customer_id, payment_id, product_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).bind(id, key, payment.customer?.email ?? null, payment.customer?.customer_id ?? null, paymentId, productId, 'active', Date.now()).run();
  return key;
};

const dodoWebhook = async (request, env) => {
  const body = await request.text();
  const ok = await verifyStandardWebhook({
    secret: env.DODO_WEBHOOK_SECRET,
    id: request.headers.get('webhook-id'),
    timestamp: request.headers.get('webhook-timestamp'),
    signatureHeader: request.headers.get('webhook-signature'),
    body,
  });
  if (!ok) return fail(401, 'bad_signature', 'Webhook signature verification failed.');

  let event;
  try {
    event = JSON.parse(body);
  } catch {
    return fail(400, 'bad_payload', 'Body is not JSON.');
  }

  const eventId = request.headers.get('webhook-id');
  const seen = await env.DB.prepare('SELECT id FROM webhook_events WHERE id = ?').bind(eventId).first();
  if (seen) return json({ ok: true, duplicate: true });
  await env.DB.prepare('INSERT INTO webhook_events (id, type, received_at) VALUES (?, ?, ?)')
    .bind(eventId, String(event.type ?? ''), Date.now()).run();

  const data = event.data ?? {};
  switch (event.type) {
    case 'payment.succeeded': {
      if (env.DODO_PRODUCT_ID) {
        const inCart = Array.isArray(data.product_cart) && data.product_cart.some((item) => item.product_id === env.DODO_PRODUCT_ID);
        if (!inCart) return json({ ok: true, ignored: 'other_product' });
      }
      await issueLicenseForPayment(env, data);
      return json({ ok: true });
    }
    case 'refund.succeeded':
    case 'dispute.won':
    case 'dispute.accepted': {
      const paymentId = data.payment_id;
      if (paymentId) {
        await env.DB.prepare("UPDATE licenses SET status = 'revoked', revoked_at = ? WHERE payment_id = ?")
          .bind(Date.now(), paymentId).run();
      }
      return json({ ok: true });
    }
    default:
      return json({ ok: true, ignored: event.type });
  }
};

// ---------------------------------------------------------------------------
// Admin (bearer ADMIN_TOKEN): issue keys by hand, revoke.

const requireAdmin = (request, env) => {
  const header = request.headers.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  return Boolean(env.ADMIN_TOKEN) && token === env.ADMIN_TOKEN;
};

const adminIssue = async (request, env) => {
  if (!requireAdmin(request, env)) return fail(401, 'unauthorized', 'Admin token required.');
  const body = await readJson(request);
  const key = generateKey();
  await env.DB.prepare(
    'INSERT INTO licenses (id, key, email, payment_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).bind(crypto.randomUUID(), key, body?.email ?? null, body?.paymentId ?? `manual-${crypto.randomUUID()}`, 'active', Date.now()).run();
  return json({ key });
};

const adminRevoke = async (request, env) => {
  if (!requireAdmin(request, env)) return fail(401, 'unauthorized', 'Admin token required.');
  const body = await readJson(request);
  const key = normalizeKey(body?.key);
  if (!key) return fail(400, 'invalid_key', 'A license key is required.');
  const result = await env.DB.prepare("UPDATE licenses SET status = 'revoked', revoked_at = ? WHERE key = ?")
    .bind(Date.now(), key).run();
  return json({ ok: true, changed: result.meta.changes });
};

// ---------------------------------------------------------------------------
// Update check: latest GitHub release, cached for 10 minutes.

const updateCheck = async (request, env, ctx) => {
  const cache = caches.default;
  const cacheKey = new Request(`https://cache.shipchamber.internal/release/${env.GITHUB_REPO}`);
  let release = null;
  const cached = await cache.match(cacheKey);
  if (cached) {
    release = await cached.json();
  } else {
    const upstream = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/releases/latest`, {
      headers: { 'user-agent': 'shipchamber-api', accept: 'application/vnd.github+json' },
    });
    if (upstream.ok) {
      release = await upstream.json();
      ctx.waitUntil(cache.put(cacheKey, new Response(JSON.stringify(release), {
        headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=600' },
      })));
    }
  }
  if (!release?.tag_name) return json({ latestVersion: null, updateAvailable: false, nextSuggestedCheckInSec: 3600 });

  const body = await readJson(request);
  const latestVersion = String(release.tag_name).replace(/^v/, '');
  const currentVersion = typeof body?.currentVersion === 'string' ? body.currentVersion : null;
  return json({
    latestVersion,
    updateAvailable: currentVersion ? compareVersions(latestVersion, currentVersion) > 0 : true,
    releaseNotes: typeof release.body === 'string' ? release.body : undefined,
    releaseNotesUrl: release.html_url,
    downloadUrl: release.html_url,
    nextSuggestedCheckInSec: 6 * 3600,
  });
};

const compareVersions = (a, b) => {
  const pa = a.split(/[.-]/).map((p) => Number.parseInt(p, 10) || 0);
  const pb = b.split(/[.-]/).map((p) => Number.parseInt(p, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
};

// ---------------------------------------------------------------------------
// Push relay: needs an APNs key for a ShipChamber iOS app. Until one exists
// the endpoint answers honestly instead of pretending to deliver.

const pushSend = async (_request, env) => {
  if (!env.APNS_KEY_ID) return fail(501, 'push_unavailable', 'Push relay is not configured for this deployment.');
  return fail(501, 'push_unavailable', 'Push relay is not configured for this deployment.');
};

// ---------------------------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
    const { pathname } = new URL(request.url);
    const post = request.method === 'POST';

    if (pathname === '/' || pathname === '/health') return json({ ok: true, service: 'shipchamber-api' });
    if (post && pathname === '/v1/license/activate') return licenseActivate(request, env);
    if (post && pathname === '/v1/license/validate') return licenseValidate(request, env);
    if (post && pathname === '/v1/license/deactivate') return licenseDeactivate(request, env);
    if (request.method === 'GET' && pathname === '/v1/license/claim') return licenseClaim(request, env);
    if (post && pathname === '/v1/webhooks/dodo') return dodoWebhook(request, env);
    if (post && pathname === '/v1/admin/license/issue') return adminIssue(request, env);
    if (post && pathname === '/v1/admin/license/revoke') return adminRevoke(request, env);
    if (post && pathname === '/v1/update/check') return updateCheck(request, env, ctx);
    if (post && pathname === '/v1/push/send') return pushSend(request, env);
    return fail(404, 'not_found', 'No such endpoint.');
  },
};
