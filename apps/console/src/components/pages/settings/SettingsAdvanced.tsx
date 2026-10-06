import { Code2, FileText, Gauge, Shield } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { KeyValuePanel } from '../../Common';
import { PageHeader } from '../../console-ui';
import type { ConsoleData, ViewId } from '../../../types';

export function SettingsAdvanced({ data, setView }: { data: ConsoleData; setView: (view: ViewId) => void }) {
  const { t } = useTranslation('settings');
  const settings = data.settings;
  return (
    <section className="stack">
      <PageHeader title={t('advanced.title')} description={t('advanced.description')} />
      <div className="advancedSettingsGrid">
        <div className="panel subtlePanel">
          <div className="builderSetupHeader compact">
            <span className="softIcon"><Gauge size={18} /></span>
            <div>
              <h2>{t('advanced.runtimeDefaults.title')}</h2>
              <p>{t('advanced.runtimeDefaults.description')}</p>
            </div>
          </div>
          <KeyValuePanel rows={[
            [t('advanced.runtimeDefaults.loopEngine'), settings?.saved_config.loop_engine.provider ?? 'builtin'],
            [t('advanced.runtimeDefaults.metadata'), settings?.saved_config.storage.metadata.provider ?? 'sqlite'],
            [t('advanced.runtimeDefaults.artifacts'), settings?.saved_config.storage.artifacts.provider ?? 'local'],
            [t('advanced.runtimeDefaults.memory'), settings?.saved_config.memory.enabled ? settings.saved_config.memory.provider : 'off'],
            [t('advanced.runtimeDefaults.sandbox'), settings?.saved_config.sandbox.provider ?? data.runtime?.sandbox_providers[0] ?? 'local'],
          ]} />
        </div>
        <div className="panel subtlePanel">
          <div className="builderSetupHeader compact">
            <span className="softIcon"><Shield size={18} /></span>
            <div>
              <h2>{t('advanced.operationalViews.title')}</h2>
              <p>{t('advanced.operationalViews.description')}</p>
            </div>
          </div>
          <div className="settingsLinkList">
            <button type="button" onClick={() => setView('logs')}>{t('advanced.operationalViews.logs')}</button>
            <button type="button" onClick={() => setView('monitoring')}>{t('advanced.operationalViews.monitoring')}</button>
            <button type="button" onClick={() => setView('outcomes')}>{t('advanced.operationalViews.outcomes')}</button>
          </div>
        </div>
        <div className="panel subtlePanel advancedJsonPanel">
          <div className="builderSetupHeader compact">
            <span className="softIcon"><Code2 size={18} /></span>
            <div>
              <h2>{t('advanced.runtimeConfig.title')}</h2>
              <p>{t('advanced.runtimeConfig.description')}</p>
            </div>
          </div>
          <div className="settingsLinkList">
            <button type="button" onClick={() => setView('models')}>{t('advanced.runtimeConfig.models')}</button>
            <button type="button" onClick={() => setView('loop-engine')}>{t('advanced.runtimeConfig.loopEngine')}</button>
            <button type="button" onClick={() => setView('storage')}>{t('advanced.runtimeConfig.storage')}</button>
            <button type="button" onClick={() => setView('memory')}>{t('advanced.runtimeConfig.memory')}</button>
            <button type="button" onClick={() => setView('sandbox')}>{t('advanced.runtimeConfig.sandbox')}</button>
          </div>
        </div>
        <div className="panel subtlePanel">
          <div className="builderSetupHeader compact">
            <span className="softIcon"><FileText size={18} /></span>
            <div>
              <h2>{t('advanced.devReference.title')}</h2>
              <p>{t('advanced.devReference.description')}</p>
            </div>
          </div>
          <button className="secondaryButton fitButton" type="button" onClick={() => setView('api-reference')}>{t('advanced.devReference.open')}</button>
        </div>
      </div>
    </section>
  );
}
