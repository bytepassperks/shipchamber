import React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { LicenseRequestError, useLicenseStore } from '@/stores/useLicenseStore';
import {
  SettingsSection,
  SettingsStackedField,
  SETTINGS_HELPER_CLASS,
} from '@/components/sections/shared/SettingsSection';

const LIFETIME_PURCHASE_URL = 'https://shipchamber.com/#pricing';

export const LicenseSettings: React.FC<{ divider?: boolean }> = ({ divider = false }) => {
  const { t } = useI18n();
  const { status, isLoading, refresh, activate, deactivate } = useLicenseStore(useShallow((s) => ({
    status: s.status,
    isLoading: s.isLoading,
    refresh: s.refresh,
    activate: s.activate,
    deactivate: s.deactivate,
  })));
  const [key, setKey] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const isLifetime = status?.tier === 'lifetime';

  const handleActivate = async () => {
    if (!key.trim()) return;
    setBusy(true);
    try {
      await activate(key);
      setKey('');
      toast.success(t('settings.license.toast.activated'));
    } catch (error) {
      const message = error instanceof LicenseRequestError
        ? error.message
        : t('settings.license.toast.activateFailed');
      toast.error(message);
    } finally {
      setBusy(false);
    }
  };

  const handleDeactivate = async () => {
    setBusy(true);
    try {
      await deactivate();
      toast.success(t('settings.license.toast.deactivated'));
    } catch {
      toast.error(t('settings.license.toast.deactivateFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection
      title={t('settings.license.title')}
      divider={divider}
      settingsItem="general.license"
      titleAccessory={(
        <span className="rounded-md border border-border/60 px-1.5 py-0.5 typography-meta text-muted-foreground">
          {isLifetime ? t('settings.license.tier.lifetime') : t('settings.license.tier.free')}
        </span>
      )}
      info={t('settings.license.info')}
    >
      {isLifetime ? (
        <div className="space-y-3">
          <p className={SETTINGS_HELPER_CLASS}>
            {t('settings.license.state.active', { key: status?.maskedKey ?? '' })}
          </p>
          <Button size="sm" variant="outline" onClick={() => void handleDeactivate()} disabled={busy || isLoading}>
            {busy ? <Icon name="loader" className="mr-1 h-4 w-4 animate-spin" /> : null}
            {t('settings.license.actions.deactivate')}
          </Button>
        </div>
      ) : (
        <div className="space-y-4">
          <SettingsStackedField
            label={t('settings.license.field.key.label')}
            description={t('settings.license.field.key.description')}
            descriptionPlacement="after"
          >
            <Input
              value={key}
              onChange={(event) => setKey(event.target.value)}
              placeholder="SC-XXXX-XXXX-XXXX-XXXX"
              autoComplete="off"
              spellCheck={false}
              className="h-9 font-mono"
              onKeyDown={(event) => {
                if (event.key === 'Enter') void handleActivate();
              }}
            />
            <Button size="sm" onClick={() => void handleActivate()} disabled={busy || isLoading || !key.trim()}>
              {busy ? <Icon name="loader" className="mr-1 h-4 w-4 animate-spin" /> : null}
              {t('settings.license.actions.activate')}
            </Button>
          </SettingsStackedField>
          <a
            href={LIFETIME_PURCHASE_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 typography-meta text-muted-foreground transition-colors hover:text-foreground"
          >
            <Icon name="global" className="h-4 w-4" />
            <span>{t('settings.license.actions.buy')}</span>
          </a>
        </div>
      )}
    </SettingsSection>
  );
};
