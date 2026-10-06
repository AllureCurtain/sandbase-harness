import { ReactNode } from 'react';
import { RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export function KeyValuePanel({ rows }: { rows: Array<[string, ReactNode]> }) {
  const { t } = useTranslation();
  return (
    <div className="tablePanel kv">
      {rows.map(([key, value]) => (
        <div className="kvRow" key={key}>
          <span>{key}</span>
          <strong>{value || t('kv.notConfigured')}</strong>
        </div>
      ))}
    </div>
  );
}

export function LoadingState({ label }: { label?: string } = {}) {
  const { t } = useTranslation();
  return <div className="loading"><RefreshCw size={18} />{label ?? t('loadingConsole')}</div>;
}

export function RequiredMark() {
  return <span className="requiredMark">*</span>;
}

export function ResourceBadge({ icon, label, children }: { icon?: ReactNode; label?: ReactNode; children?: ReactNode }) {
  return (
    <span className="resourceBadge">
      {icon ? icon : null}
      <span>{label ?? children}</span>
    </span>
  );
}
