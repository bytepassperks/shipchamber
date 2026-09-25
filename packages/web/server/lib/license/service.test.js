import { describe, expect, it } from 'bun:test';

import { createLicenseService, maskLicenseKey, normalizeLicenseKey } from './service.js';

const KEY = 'SC-AB12-CD34-EF56-GH78';

const createHarness = ({ apiResponses = [], initialSettings = {}, nowValue = 1_000_000 } = {}) => {
  let settings = { ...initialSettings };
  const calls = [];
  let clock = nowValue;
  const service = createLicenseService({
    readSettingsFromDiskMigrated: async () => settings,
    writeSettingsToDisk: async (next) => {
      settings = next;
    },
    getInstallId: () => 'install-1',
    now: () => clock,
    logger: { warn: () => {} },
    fetchImpl: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      const next = apiResponses.shift();
      if (!next) throw new Error('offline');
      return {
        ok: next.status < 400,
        status: next.status,
        json: async () => next.body,
      };
    },
  });
  return {
    service,
    calls,
    getSettings: () => settings,
    advance: (ms) => {
      clock += ms;
    },
  };
};

describe('normalizeLicenseKey', () => {
  it('accepts keys with stray whitespace and lowercase', () => {
    expect(normalizeLicenseKey(' sc-ab12-cd34-ef56-gh78 ')).toBe(KEY);
  });

  it('rejects malformed keys', () => {
    expect(normalizeLicenseKey('SC-1234')).toBeNull();
    expect(normalizeLicenseKey(undefined)).toBeNull();
  });

  it('masks all but the last group', () => {
    expect(maskLicenseKey(KEY)).toBe('SC-••••-••••-••••-GH78');
  });
});

describe('createLicenseService', () => {
  it('reports the free tier with every lifetime feature disabled by default', async () => {
    const { service } = createHarness();
    const status = await service.getStatus();
    expect(status.tier).toBe('free');
    expect(status.features.relay).toBe(false);
    expect(await service.isLifetime()).toBe(false);
  });

  it('activates a key against the license API and persists it', async () => {
    const { service, calls, getSettings } = createHarness({
      apiResponses: [{ status: 200, body: { tier: 'lifetime', licenseId: 'lic_1' } }],
    });
    const status = await service.activate(KEY.toLowerCase());
    expect(status.tier).toBe('lifetime');
    expect(status.maskedKey).toBe('SC-••••-••••-••••-GH78');
    expect(calls[0].url).toBe('https://api.shipchamber.com/v1/license/activate');
    expect(calls[0].body).toEqual({ key: KEY, installId: 'install-1' });
    expect(getSettings().license.key).toBe(KEY);
    expect(await service.isLifetime()).toBe(true);
  });

  it('surfaces API rejections with their code and leaves the free tier intact', async () => {
    const { service } = createHarness({
      apiResponses: [{ status: 404, body: { code: 'not_found', error: 'Unknown key' } }],
    });
    await expect(service.activate(KEY)).rejects.toMatchObject({ code: 'not_found', statusCode: 400 });
    expect(await service.isLifetime()).toBe(false);
  });

  it('keeps the lifetime tier when revalidation cannot reach the server', async () => {
    const { service, advance } = createHarness({
      apiResponses: [{ status: 200, body: { tier: 'lifetime' } }],
    });
    await service.activate(KEY);
    advance(2 * 24 * 60 * 60 * 1000);
    const status = await service.revalidate();
    expect(status.tier).toBe('lifetime');
  });

  it('downgrades when the server explicitly revokes the key', async () => {
    const { service, advance, getSettings } = createHarness({
      apiResponses: [
        { status: 200, body: { tier: 'lifetime' } },
        { status: 403, body: { code: 'revoked', error: 'Revoked' } },
      ],
    });
    await service.activate(KEY);
    advance(2 * 24 * 60 * 60 * 1000);
    const status = await service.revalidate();
    expect(status.tier).toBe('free');
    expect(getSettings().license).toBeUndefined();
  });

  it('deactivates locally even when the remote release fails', async () => {
    const { service, getSettings } = createHarness({
      apiResponses: [{ status: 200, body: { tier: 'lifetime' } }],
    });
    await service.activate(KEY);
    const status = await service.deactivate();
    expect(status.tier).toBe('free');
    expect(getSettings().license).toBeUndefined();
  });
});
