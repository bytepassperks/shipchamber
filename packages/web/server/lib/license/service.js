// License service: Free / Lifetime entitlement for this ShipChamber instance.
//
// The license key is activated against the ShipChamber license API and the
// result is persisted in the server settings file as
// `settings.license = { key, tier, licenseId, activatedAt, lastValidatedAt }`
// (same storage precedent as tunnels/relay/notifications).
//
// Entitlement is enforced server-side (relay pairing, `relayAvailable`) and
// mirrored to shared UI through `GET /api/shipchamber/license`. Failed
// re-validation never downgrades an activated license on its own: the last
// server-confirmed tier stays authoritative through a grace window so an
// offline machine keeps working; only an explicit `revoked`/`invalid` answer
// from the API clears it.

import express from 'express';

const DEFAULT_LICENSE_API_URL = 'https://shipchamber-api.getlaunchpod.workers.dev';
const LICENSE_TIERS = Object.freeze({ FREE: 'free', LIFETIME: 'lifetime' });
const LIFETIME_FEATURES = Object.freeze(['relay', 'multiRun', 'sessionGoals', 'walkthrough']);

const REVALIDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const OFFLINE_GRACE_MS = 14 * 24 * 60 * 60 * 1000;
const KEY_PATTERN = /^SC-[A-Z0-9]{4}(?:-[A-Z0-9]{4}){3}$/;

const resolveApiBaseUrl = () => {
  const raw = process.env.SHIPCHAMBER_LICENSE_API_URL;
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const url = new URL(raw.trim());
      if (url.protocol === 'https:' || url.protocol === 'http:') return url.toString().replace(/\/$/, '');
    } catch {
      // Fall through to default.
    }
  }
  return DEFAULT_LICENSE_API_URL;
};

export const normalizeLicenseKey = (value) => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase().replace(/\s+/g, '');
  return KEY_PATTERN.test(normalized) ? normalized : null;
};

export const maskLicenseKey = (key) => {
  if (typeof key !== 'string' || key.length < 4) return null;
  return `SC-••••-••••-••••-${key.slice(-4)}`;
};

const parseStoredLicense = (raw) => {
  if (!raw || typeof raw !== 'object') return null;
  const key = normalizeLicenseKey(raw.key);
  if (!key || raw.tier !== LICENSE_TIERS.LIFETIME) return null;
  const activatedAt = typeof raw.activatedAt === 'number' ? raw.activatedAt : Date.now();
  const lastValidatedAt = typeof raw.lastValidatedAt === 'number' ? raw.lastValidatedAt : activatedAt;
  const licenseId = typeof raw.licenseId === 'string' ? raw.licenseId : null;
  return { key, tier: LICENSE_TIERS.LIFETIME, licenseId, activatedAt, lastValidatedAt };
};

class LicenseApiError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

/**
 * @param {{
 *   readSettingsFromDiskMigrated: () => Promise<object>,
 *   writeSettingsToDisk: (settings: object) => Promise<void>,
 *   getInstallId: () => string,
 *   fetchImpl?: typeof fetch,
 *   now?: () => number,
 *   logger?: Pick<Console, 'warn'>,
 * }} deps
 */
export const createLicenseService = ({
  readSettingsFromDiskMigrated,
  writeSettingsToDisk,
  getInstallId,
  fetchImpl = fetch,
  now = () => Date.now(),
  logger = console,
}) => {
  const readStored = async () => {
    const settings = await readSettingsFromDiskMigrated();
    return parseStoredLicense(settings?.license);
  };

  const writeStored = async (license) => {
    const settings = await readSettingsFromDiskMigrated();
    const next = { ...settings };
    if (license) {
      next.license = license;
    } else {
      delete next.license;
    }
    await writeSettingsToDisk(next);
  };

  const callApi = async (path, body) => {
    let response;
    try {
      response = await fetchImpl(`${resolveApiBaseUrl()}${path}`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
    } catch (error) {
      throw new LicenseApiError('network', `License server unreachable: ${error?.message ?? error}`, 502);
    }
    const data = await response.json().catch(() => null);
    if (!response.ok || !data || typeof data !== 'object') {
      const code = typeof data?.code === 'string' ? data.code : 'invalid';
      const message = typeof data?.error === 'string' ? data.error : `License request failed (${response.status})`;
      throw new LicenseApiError(code, message, response.status >= 500 ? 502 : 400);
    }
    return data;
  };

  const toStatus = (license) => ({
    tier: license ? LICENSE_TIERS.LIFETIME : LICENSE_TIERS.FREE,
    maskedKey: license ? maskLicenseKey(license.key) : null,
    activatedAt: license?.activatedAt ?? null,
    lastValidatedAt: license?.lastValidatedAt ?? null,
    features: Object.fromEntries(LIFETIME_FEATURES.map((feature) => [feature, Boolean(license)])),
  });

  const getStatus = async () => toStatus(await readStored());

  const isLifetime = async () => {
    try {
      return Boolean(await readStored());
    } catch {
      return false;
    }
  };

  const activate = async (rawKey) => {
    const key = normalizeLicenseKey(rawKey);
    if (!key) throw new LicenseApiError('invalid_key', 'That does not look like a ShipChamber license key (SC-XXXX-XXXX-XXXX-XXXX).');
    const data = await callApi('/v1/license/activate', { key, installId: getInstallId() });
    if (data.tier !== LICENSE_TIERS.LIFETIME) {
      throw new LicenseApiError('invalid', 'License server did not grant a Lifetime entitlement.');
    }
    const timestamp = now();
    const license = {
      key,
      tier: LICENSE_TIERS.LIFETIME,
      licenseId: typeof data.licenseId === 'string' ? data.licenseId : null,
      activatedAt: timestamp,
      lastValidatedAt: timestamp,
    };
    await writeStored(license);
    return toStatus(license);
  };

  const deactivate = async () => {
    const current = await readStored();
    if (current) {
      try {
        await callApi('/v1/license/deactivate', { key: current.key, installId: getInstallId() });
      } catch (error) {
        // Local removal is the user's intent; releasing the seat remotely is best-effort.
        logger.warn(`[License] remote deactivate failed: ${error?.message ?? error}`);
      }
    }
    await writeStored(null);
    return toStatus(null);
  };

  // Periodic re-validation. Only an explicit negative answer from the API
  // downgrades; transport failures keep the last confirmed tier until the
  // offline grace window is exhausted.
  const revalidate = async () => {
    const current = await readStored();
    if (!current) return toStatus(null);
    const age = now() - current.lastValidatedAt;
    if (age < REVALIDATE_INTERVAL_MS) return toStatus(current);
    try {
      const data = await callApi('/v1/license/validate', { key: current.key, installId: getInstallId() });
      if (data.tier === LICENSE_TIERS.LIFETIME) {
        const refreshed = { ...current, lastValidatedAt: now() };
        await writeStored(refreshed);
        return toStatus(refreshed);
      }
      await writeStored(null);
      return toStatus(null);
    } catch (error) {
      if (error instanceof LicenseApiError && error.code !== 'network' && error.statusCode < 500) {
        await writeStored(null);
        return toStatus(null);
      }
      if (age > OFFLINE_GRACE_MS) {
        logger.warn('[License] offline grace window exhausted; reverting to Free until the license server is reachable');
        return toStatus(null);
      }
      return toStatus(current);
    }
  };

  const sendError = (res, error) => {
    if (error instanceof LicenseApiError) {
      res.status(error.statusCode).json({ code: error.code, error: error.message });
      return;
    }
    res.status(500).json({ code: 'internal', error: error?.message ?? 'License operation failed' });
  };

  const registerRoutes = (app) => {
    app.get('/api/shipchamber/license', async (_req, res) => {
      try {
        res.json(await revalidate());
      } catch (error) {
        sendError(res, error);
      }
    });

    app.post('/api/shipchamber/license/activate', express.json({ limit: '4kb' }), async (req, res) => {
      try {
        res.json(await activate(req.body?.key));
      } catch (error) {
        sendError(res, error);
      }
    });

    app.post('/api/shipchamber/license/deactivate', async (_req, res) => {
      try {
        res.json(await deactivate());
      } catch (error) {
        sendError(res, error);
      }
    });
  };

  return { registerRoutes, getStatus, isLifetime, activate, deactivate, revalidate };
};
