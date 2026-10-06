import { useMemo, useState, type ReactNode } from 'react';
import { Copy, PanelRightClose } from 'lucide-react';
import { copyText } from '../lib/format';
import { EquivalentRequestPanel } from './EquivalentRequestPanel';

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
  const [pasteText, setPasteText] = useState('');
  return (
    <aside className="configDrawer">
      <div className="configDrawerHead">
        <strong>Config preview</strong>
        <div className="configDrawerActions">
          <div className="segment compactSegment">
            <button type="button" className={format === 'yaml' ? 'active' : ''} onClick={() => onFormat('yaml')}>YAML</button>
            <button type="button" className={format === 'json' ? 'active' : ''} onClick={() => onFormat('json')}>JSON</button>
          </div>
          <button className="iconButton quiet" type="button" title="Copy config" aria-label="Copy config"
            onClick={() => void copyText(text)}>
            <Copy size={15} />
          </button>
          {onCollapse ? (
            <button className="iconButton quiet" type="button" title="Hide preview" aria-label="Hide preview"
              onClick={onCollapse}>
              <PanelRightClose size={15} />
            </button>
          ) : null}
        </div>
      </div>
      <pre className="configDrawerView">{text}</pre>
      {onParse ? (
        <details className="configDrawerPaste">
          <summary>Paste a config — fill the form from it</summary>
          <textarea
            value={pasteText}
            onChange={(event) => setPasteText(event.target.value)}
            placeholder="Paste a YAML or JSON definition…"
            spellCheck={false}
          />
          <button className="secondaryButton" type="button" disabled={!pasteText.trim()}
            onClick={() => onParse(pasteText)}>
            Parse &amp; fill form
          </button>
          {parseError ? <span className="fieldError" role="alert">{parseError}</span> : null}
        </details>
      ) : null}
      {request ? (
        <details className="configDrawerRequest">
          <summary>Equivalent API request</summary>
          <EquivalentRequestPanel request={request} bare />
        </details>
      ) : null}
    </aside>
  );
}

/** Toggle that lives in a modal's action bar when the drawer is collapsible. */
export function DrawerToggle({ open, onToggle, children }: { open: boolean; onToggle: () => void; children?: ReactNode }) {
  return (
    <button className="ghostButton compactButton" type="button" aria-pressed={open} onClick={onToggle}>
      {children ?? 'Config preview'} {open ? '▾' : '▸'}
    </button>
  );
}

/** Serialize a draft object into the active format. Kept tiny: yaml pkg owns the real work in callers. */
export function useSerialized(draft: unknown, format: ConfigFormat, toYaml: (value: unknown) => string): string {
  return useMemo(() => (format === 'json' ? `${JSON.stringify(draft, null, 2)}\n` : toYaml(draft)), [draft, format, toYaml]);
}
