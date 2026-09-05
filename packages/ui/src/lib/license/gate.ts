import { toast } from '@/components/ui';
import type { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { selectHasFeature, useLicenseStore, type LifetimeFeature } from '@/stores/useLicenseStore';

type TranslateFn = ReturnType<typeof useI18n>['t'];

export const openLicenseSettings = (): void => {
  const ui = useUIStore.getState();
  ui.setSettingsPage('general');
  ui.setSettingsDialogOpen(true);
};

/** Imperative check for click handlers: false means a toast was shown and the action must not run. */
export const requireLifetimeFeature = (feature: LifetimeFeature, t: TranslateFn): boolean => {
  if (selectHasFeature(feature)(useLicenseStore.getState())) return true;
  toast.info(t('settings.license.upgrade.body'), {
    action: { label: t('settings.license.upgrade.open'), onClick: openLicenseSettings },
  });
  return false;
};
