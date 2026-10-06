import { type ReactNode } from 'react';
import { Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/**
 * Shared form kit for the Console workflow surfaces.
 *
 * These primitives implement the "form-first, config-second" redesign: every
 * consequential create/edit modal composes them so labels, helpers, section
 * numbering, row editors, and the pre-submit check all read the same way.
 */

/** One labelled control: label (with optional marker) + control + helper + error. */
export function FieldRow({
  label,
  optional,
  required,
  helper,
  error,
  children,
}: {
  label: ReactNode;
  optional?: string;
  required?: boolean;
  helper?: ReactNode;
  error?: string;
  children: ReactNode;
}) {
  return (
    <label className="fieldRow">
      <span className="fieldRowLabel">
        {label}
        {required ? <span className="requiredMark">*</span> : null}
        {optional ? <small className="optionalPill">{optional}</small> : null}
      </span>
      {children}
      {error ? <span className="fieldError" role="alert">{error}</span> : null}
      {helper ? <span className="fieldHelper">{helper}</span> : null}
    </label>
  );
}

/** A numbered form section. The number is an ordinal the CheckCard can jump to. */
export function SectionCard({
  n,
  title,
  hint,
  children,
}: {
  n?: number;
  title: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="formCard">
      <div className="formCardHead">
        {n !== undefined ? <span className="formCardNum">{n}</span> : null}
        <h3>{title}</h3>
      </div>
      {hint ? <p className="formCardHint">{hint}</p> : null}
      {children}
    </section>
  );
}

export type KvRow = { id: string; key: string; value: string };

let kvRowSeq = 0;
export function newKvRow(key = '', value = ''): KvRow {
  return { id: `kv_${++kvRowSeq}`, key, value };
}

export function kvRowsFromObject(obj: Record<string, unknown> | undefined): KvRow[] {
  return Object.entries(obj ?? {}).map(([key, value]) => newKvRow(key, typeof value === 'string' ? value : JSON.stringify(value)));
}

/** key/value row editor for metadata and flat object shapes. */
export function KvRowEditor({
  rows,
  onChange,
  keyPlaceholder = 'key',
  valuePlaceholder = 'value',
  addLabel = 'Add row',
}: {
  rows: KvRow[];
  onChange: (rows: KvRow[]) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  addLabel?: string;
}) {
  const update = (id: string, patch: Partial<KvRow>) =>
    onChange(rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  return (
    <div className="kvEditor">
      {rows.map((row) => (
        <div className="kvEditorRow" key={row.id}>
          <input className="monoInput" value={row.key} placeholder={keyPlaceholder}
            onChange={(event) => update(row.id, { key: event.target.value })} />
          <input className="monoInput" value={row.value} placeholder={valuePlaceholder}
            onChange={(event) => update(row.id, { value: event.target.value })} />
          <button className="iconButton quiet" type="button" aria-label="Remove row"
            onClick={() => onChange(rows.filter((candidate) => candidate.id !== row.id))}>
            <Trash2 size={16} />
          </button>
        </div>
      ))}
      <button className="addRowButton" type="button" onClick={() => onChange([...rows, newKvRow()])}>
        + {addLabel}
      </button>
    </div>
  );
}

/** Mutually-exclusive choice rendered as cards with a consequence line. */
export function RadioCardGroup<TValue extends string>({
  value,
  options,
  onChange,
}: {
  value: TValue;
  options: Array<{ value: TValue; title: string; body?: ReactNode; consequence?: ReactNode }>;
  onChange: (value: TValue) => void;
}) {
  return (
    <div className="radioCardGrid" role="radiogroup">
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            type="button"
            key={option.value}
            role="radio"
            aria-checked={selected}
            className={`radioCard${selected ? ' selected' : ''}`}
            onClick={() => onChange(option.value)}
          >
            <span className="radioCardDot" aria-hidden="true" />
            <span className="radioCardBody">
              <strong>{option.title}</strong>
              {option.body ? <small>{option.body}</small> : null}
              {option.consequence ? <em className="radioCardConsequence">{option.consequence}</em> : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export type CheckItem = {
  label: string;
  /** The value being shown back to the user — "¥100 · 50 seats", not "OK". */
  value: ReactNode;
  state: 'ok' | 'blocking' | 'advisory';
  /** Element id the "fix" link scrolls to. */
  targetId?: string;
};

/**
 * The live pre-submit check. Every row shows the actual value, every blocking
 * row carries a jump link back to its section.
 */
export function CheckCard({ items, onJump }: { items: CheckItem[]; onJump?: (targetId: string) => void }) {
  const { t } = useTranslation();
  const blockers = items.filter((item) => item.state === 'blocking').length;
  return (
    <div className="checkCard" aria-live="polite">
      <div className="checkCardHead">
        <strong>{t('check.title')}</strong>
        {blockers ? <span className="checkCardWarn">{t('check.toFix', { n: blockers })}</span> : <span className="checkCardOk">{t('check.allGood')}</span>}
      </div>
      {items.map((item) => (
        <div className="checkRow" key={item.label}>
          <span className={`checkState ${item.state}`} aria-hidden="true">
            {item.state === 'ok' ? '✓' : item.state === 'blocking' ? '⚠' : 'ⓘ'}
          </span>
          <span className="checkLabel">{item.label}</span>
          <span className="checkValue">{item.value}</span>
          {item.state === 'blocking' && item.targetId ? (
            <button type="button" className="linkButton checkJump"
              onClick={() => {
                document.getElementById(item.targetId!)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                onJump?.(item.targetId!);
              }}>
              {t('check.fix')} →
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}
