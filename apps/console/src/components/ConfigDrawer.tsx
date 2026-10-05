import { useMemo, useState, type ReactNode } from 'react';
import { Copy, PanelRightClose, WrapText } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { copyText } from '../lib/format';
import { EquivalentRequestPanel } from './EquivalentRequestPanel';
import { SegmentedControl } from './console-ui';

export type ConfigFormat = 'yaml' | 'json';

export type ConfigRequest = import('../lib/equivalentRequest').EquivalentRequest | null;

/**
 * The right-hand drawer of a workflow modal: a live rendered view of the
 * config the form is building (YAML or JSON), a paste slot that parses a
 * pasted definition back into the form, and the equivalent API request folded
 * out of the primary path. The drawer is a developer surface — it must never
 * be required to finish the form.
 */
export function ConfigPreviewDrawer({
  text,
  format,
  onFormat,
  request,
  onParse,
  parseError,
  onCollapse,
}: {
  /** Serialized config text (already in `format`). */
  text: string;
  format: ConfigFormat;
  onFormat: (format: ConfigFormat) => void;
  /** Equivalent request to fold into the collapsible panel. */
  request?: ConfigRequest;
  /** Called with the pasted text; the owner parses and fills the form. */
  onParse: (text: string) => void;
  parseError?: string;
  onCollapse?: () => void;
}) {
  const { t } = useTranslation();
  const [pasteText, setPasteText] = useState('');
  const [wrap, setWrap] = useState(false);
  return (
    <aside className="configDrawer">
      <div className="configDrawerHead">
        <strong>{t('configDrawer.title')}</strong>
        <div className="configDrawerActions">
          <SegmentedControl
            label={t('configDrawer.title')}
            value={format}
            options={[
              { value: 'yaml', label: 'YAML' },
              { value: 'json', label: 'JSON' },
            ]}
            onChange={onFormat}
          />
          <button className={`iconButton quiet${wrap ? ' active' : ''}`} type="button"
            title={wrap ? t('configDrawer.unwrap') : t('configDrawer.wrap')}
            aria-label={wrap ? t('configDrawer.unwrap') : t('configDrawer.wrap')}
            aria-pressed={wrap}
            onClick={() => setWrap((current) => !current)}>
            <WrapText size={15} />
          </button>
          <button className="iconButton quiet" type="button" title={t('configDrawer.copy')} aria-label={t('configDrawer.copy')}
            onClick={() => void copyText(text)}>
            <Copy size={15} />
          </button>
          {onCollapse ? (
            <button className="iconButton quiet" type="button" title={t('configDrawer.hide')} aria-label={t('configDrawer.hide')}
              onClick={onCollapse}>
              <PanelRightClose size={15} />
            </button>
          ) : null}
        </div>
      </div>
      <pre className={wrap ? 'configDrawerView wrapped' : 'configDrawerView'}>{text}</pre>
      {onParse ? (
        <details className="configDrawerPaste">
          <summary>{t('configDrawer.pasteTitle')}</summary>
          <textarea
            value={pasteText}
            onChange={(event) => setPasteText(event.target.value)}
            placeholder={t('configDrawer.pastePlaceholder')}
            spellCheck={false}
          />
          <button className="button outline" type="button" disabled={!pasteText.trim()}
            onClick={() => onParse(pasteText)}>
            {t('configDrawer.pasteFill')}
          </button>
          {parseError ? <span className="fieldError" role="alert">{parseError}</span> : null}
        </details>
      ) : null}
      {request ? (
        <details className="configDrawerRequest">
          <summary>{t('configDrawer.equivalentRequest')}</summary>
          <EquivalentRequestPanel request={request} bare />
        </details>
      ) : null}
    </aside>
  );
}

/** Toggle that lives in a modal's action bar when the drawer is collapsible. */
export function DrawerToggle({ open, onToggle, children }: { open: boolean; onToggle: () => void; children?: ReactNode }) {
  const { t } = useTranslation();
  return (
    <button className="button outline compactButton" type="button" aria-pressed={open} onClick={onToggle}>
      {children ?? t('configDrawer.title')} {open ? '▾' : '▸'}
    </button>
  );
}

/** Serialize a draft object into the active format. Kept tiny: yaml pkg owns the real work in callers. */
export function useSerialized(draft: unknown, format: ConfigFormat, toYaml: (value: unknown) => string): string {
  return useMemo(() => (format === 'json' ? `${JSON.stringify(draft, null, 2)}\n` : toYaml(draft)), [draft, format, toYaml]);
}
