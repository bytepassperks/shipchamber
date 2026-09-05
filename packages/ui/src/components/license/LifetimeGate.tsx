import React from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { openLicenseSettings } from '@/lib/license/gate';
import { selectHasFeature, useLicenseStore, type LifetimeFeature } from '@/stores/useLicenseStore';

/** Reads the connected instance's entitlement for one Lifetime feature. */
const useLifetimeFeature = (feature: LifetimeFeature): boolean => {
  const refresh = useLicenseStore((s) => s.refresh);
  React.useEffect(() => {
    void refresh();
  }, [refresh]);
  return useLicenseStore(selectHasFeature(feature));
};

interface LifetimeGateProps {
  feature: LifetimeFeature;
  children: React.ReactNode;
}

/** Renders children when the instance is licensed for `feature`; otherwise a quiet upgrade panel. */
export const LifetimeGate: React.FC<LifetimeGateProps> = ({ feature, children }) => {
  const { t } = useI18n();
  const allowed = useLifetimeFeature(feature);
  if (allowed) return <>{children}</>;
  return (
    <div className="flex h-full w-full items-center justify-center p-6">
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        <Icon name="lock" className="h-6 w-6 text-muted-foreground" />
        <h3 className="typography-ui font-medium text-foreground">{t('settings.license.upgrade.title')}</h3>
        <p className="typography-meta text-muted-foreground">{t('settings.license.upgrade.body')}</p>
        <Button size="sm" onClick={openLicenseSettings}>{t('settings.license.upgrade.open')}</Button>
      </div>
    </div>
  );
};
