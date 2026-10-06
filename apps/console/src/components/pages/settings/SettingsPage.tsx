import { X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { ConsoleData, ViewId } from '../../../types';
import { SETTINGS_GROUP_LABEL_KEYS, SETTINGS_GROUPS, SETTINGS_SECTIONS, type SettingsSection } from './navigation';
import './settings.css';

// V1 Settings default environment seed: "{\"hosting_type\":\"local\",\"sandbox_provider\":\"local\"}".

export function SettingsPage({
  data,
  section,
  setView,
  renderSection,
}: {
  data: ConsoleData;
  section: SettingsSection;
  setView: (view: ViewId) => void;
  renderSection: (section: SettingsSection) => ReactNode;
}) {
  const { t } = useTranslation('settings');
  const [active, setActive] = useState<SettingsSection>(section);

  useEffect(() => {
    setActive(section);
  }, [section]);

  return (
    <section className="settingsShell">
      <aside className="settingsSidebar" aria-label={t('nav.title')}>
        <div className="settingsSidebarHeader">
          <strong>{t('nav.title')}</strong>
          <button className="iconButton quiet" type="button" title={t('nav.back')} onClick={() => setView('agents')}>
            <X size={17} />
          </button>
        </div>
        {SETTINGS_GROUPS.map((group) => (
          <div className="settingsNavGroup" key={group}>
            <div className="settingsGroupLabel">{t(SETTINGS_GROUP_LABEL_KEYS[group])}</div>
            <div className="settingsNav">
              {SETTINGS_SECTIONS.filter((item) => item.group === group).map((item) => {
                const Icon = item.icon;
                const nextView: ViewId = item.id === 'general' ? 'settings' : item.id;
                return (
                  <button
                    type="button"
                    key={item.id}
                    className={`settingsNavItem ${active === item.id ? 'active' : ''}`}
                    onClick={() => {
                      setActive(item.id);
                      setView(nextView);
                    }}
                  >
                    <Icon size={18} />
                    <span>{t(item.labelKey)}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </aside>
      <div className="settingsContent">
        {renderSection(active)}
      </div>
    </section>
  );
}
