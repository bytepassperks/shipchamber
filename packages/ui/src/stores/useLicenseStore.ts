import { create } from 'zustand';
import { z } from 'zod';
import { runtimeFetch } from '@/lib/runtime-fetch';

export type LifetimeFeature = 'relay' | 'multiRun' | 'sessionGoals' | 'walkthrough';

const licenseStatusSchema = z.object({
  tier: z.enum(['free', 'lifetime']),
  maskedKey: z.string().nullable(),
  activatedAt: z.number().nullable(),
  lastValidatedAt: z.number().nullable(),
  features: z.record(z.string(), z.boolean()),
});

type LicenseStatus = z.infer<typeof licenseStatusSchema>;

const licenseErrorSchema = z.object({
  code: z.string().optional(),
  error: z.string().optional(),
});

export class LicenseRequestError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}


type LicenseStore = {
  status: LicenseStatus | null;
  isLoading: boolean;
  hasChecked: boolean;
  refresh: (options?: { force?: boolean }) => Promise<LicenseStatus | null>;
  activate: (key: string) => Promise<LicenseStatus>;
  deactivate: () => Promise<LicenseStatus>;
  /** The license belongs to the connected instance; switching instances drops it. */
  resetForRuntimeSwitch: () => void;
};

const requestLicense = async (path: string, init?: RequestInit): Promise<LicenseStatus> => {
  const response = await runtimeFetch(path, {
    ...init,
    headers: { Accept: 'application/json', ...(init?.headers ?? {}) },
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const parsedError = licenseErrorSchema.safeParse(payload);
    const code = parsedError.success && parsedError.data.code ? parsedError.data.code : 'request_failed';
    const message = parsedError.success && parsedError.data.error
      ? parsedError.data.error
      : `License request failed (${response.status})`;
    throw new LicenseRequestError(code, message);
  }
  const parsed = licenseStatusSchema.safeParse(payload);
  if (!parsed.success) throw new LicenseRequestError('invalid_response', 'Invalid license response');
  return parsed.data;
};

let inFlightRefresh: Promise<LicenseStatus | null> | null = null;
let generation = 0;

export const useLicenseStore = create<LicenseStore>((set, get) => ({
  status: null,
  isLoading: false,
  hasChecked: false,
  refresh: async (options) => {
    const { hasChecked, status } = get();
    if (hasChecked && !options?.force) return status;
    if (inFlightRefresh) return inFlightRefresh;

    const requestGeneration = generation;
    set({ isLoading: true });
    inFlightRefresh = (async () => {
      try {
        const next = await requestLicense('/api/shipchamber/license', { method: 'GET' });
        if (requestGeneration !== generation) return null;
        set({ status: next, isLoading: false, hasChecked: true });
        return next;
      } catch {
        if (requestGeneration !== generation) return null;
        // A failed read is not an authoritative "free": keep the last known status.
        set({ isLoading: false, hasChecked: true });
        return get().status;
      } finally {
        inFlightRefresh = null;
      }
    })();
    return inFlightRefresh;
  },
  activate: async (key) => {
    const next = await requestLicense('/api/shipchamber/license/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key }),
    });
    set({ status: next, hasChecked: true });
    return next;
  },
  deactivate: async () => {
    const next = await requestLicense('/api/shipchamber/license/deactivate', { method: 'POST' });
    set({ status: next, hasChecked: true });
    return next;
  },
  resetForRuntimeSwitch: () => {
    generation += 1;
    inFlightRefresh = null;
    set({ status: null, isLoading: false, hasChecked: false });
  },
}));


export const selectHasFeature = (feature: LifetimeFeature) => (state: LicenseStore): boolean => (
  state.status?.features[feature] ?? false
);
