import { Check, ChevronDown, Search } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';

export type ResourcePickerOption = {
  id: string;
  title: string;
  subtitle?: string;
  badge?: string;
  icon?: ReactNode;
};

type PickerBaseProps = {
  label: string;
  manageLabel?: string;
  onManage?: () => void;
  searchPlaceholder: string;
};

export function ResourcePicker({
  label,
  manageLabel,
  onManage,
  searchPlaceholder,
  placeholder,
  value,
  options,
  onValue,
}: PickerBaseProps & {
  placeholder: string;
  value: string;
  options: ResourcePickerOption[];
  onValue: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = options.find((option) => option.id === value);
  const filtered = filterOptions(options, query);

  useDismissPicker(rootRef, open, () => {
    setOpen(false);
    setQuery('');
  });

  return (
    <div className="resourcePicker" ref={rootRef}>
      <PickerLabel label={label} manageLabel={manageLabel} onManage={onManage} />
      <button
        className={`resourcePickerTrigger ${selected ? 'selected' : ''}`}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <PickerValue title={selected?.title ?? placeholder} subtitle={selected?.subtitle} />
        {selected?.badge ? <span className="resourcePickerBadge">{selected.badge}</span> : null}
        <ChevronDown className="resourcePickerChevron" size={18} aria-hidden="true" />
      </button>
      {open ? (
        <PickerPopover searchPlaceholder={searchPlaceholder} query={query} onQuery={setQuery}>
          {filtered.map((option) => (
            <button
              className={`resourcePickerOption ${option.id === value ? 'active' : ''}`}
              type="button"
              role="option"
              aria-selected={option.id === value}
              key={option.id}
              onClick={() => {
                onValue(option.id);
                setOpen(false);
                setQuery('');
              }}
            >
              <PickerIcon icon={option.icon} title={option.title} />
              <PickerValue title={option.title} subtitle={option.subtitle} />
              {option.badge ? <span className="resourcePickerBadge">{option.badge}</span> : null}
              <Check className="resourcePickerCheck" size={16} aria-hidden="true" />
            </button>
          ))}
          {!filtered.length ? <PickerEmpty /> : null}
        </PickerPopover>
      ) : null}
    </div>
  );
}

export function MultiResourcePicker({
  label,
  manageLabel,
  onManage,
  searchPlaceholder,
  placeholder,
  selected,
  options,
  onToggle,
}: PickerBaseProps & {
  placeholder: string;
  selected: Set<string>;
  options: ResourcePickerOption[];
  onToggle: (id: string, checked: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const selectedOptions = options.filter((option) => selected.has(option.id));
  const filtered = filterOptions(options, query);

  useDismissPicker(rootRef, open, () => {
    setOpen(false);
    setQuery('');
  });

  return (
    <div className="resourcePicker" ref={rootRef}>
      <PickerLabel label={label} manageLabel={manageLabel} onManage={onManage} />
      <button
        className={`resourcePickerTrigger ${selectedOptions.length ? 'selected' : ''}`}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {selectedOptions.length ? (
          <span className="resourcePickerSelection" aria-label={`${selectedOptions.length} selected`}>
            {selectedOptions.slice(0, 2).map((option) => <span className="resourcePickerChip" key={option.id}>{option.title}</span>)}
            {selectedOptions.length > 2 ? <span className="resourcePickerChip more">+{selectedOptions.length - 2} more</span> : null}
          </span>
        ) : <PickerValue title={placeholder} />}
        <ChevronDown className="resourcePickerChevron" size={18} aria-hidden="true" />
      </button>
      {open ? (
        <PickerPopover searchPlaceholder={searchPlaceholder} query={query} onQuery={setQuery}>
          {filtered.map((option) => {
            const checked = selected.has(option.id);
            return (
              <label className={`resourcePickerOption multi ${checked ? 'active' : ''}`} key={option.id}>
                <input type="checkbox" checked={checked} onChange={(event) => onToggle(option.id, event.target.checked)} />
                <span className="resourcePickerCheckbox" aria-hidden="true"><Check size={13} /></span>
                <PickerIcon icon={option.icon} title={option.title} />
                <PickerValue title={option.title} subtitle={option.subtitle} />
              </label>
            );
          })}
          {!filtered.length ? <PickerEmpty /> : null}
        </PickerPopover>
      ) : null}
    </div>
  );
}

function PickerLabel({ label, manageLabel, onManage }: Pick<PickerBaseProps, 'label' | 'manageLabel' | 'onManage'>) {
  return (
    <span className="resourcePickerLabel">
      <span>{label}</span>
      {manageLabel && onManage ? <button className="linkButton" type="button" onClick={onManage}>{manageLabel} ↗</button> : null}
    </span>
  );
}

function PickerValue({ title, subtitle }: { title: string; subtitle?: string }) {
  return <span className="resourcePickerValue"><strong>{title}</strong>{subtitle ? <small>{subtitle}</small> : null}</span>;
}

function PickerIcon({ icon, title }: { icon?: ReactNode; title: string }) {
  return <span className="resourcePickerIcon" aria-hidden="true">{icon ?? title.slice(0, 1).toUpperCase()}</span>;
}

function PickerPopover({ searchPlaceholder, query, onQuery, children }: { searchPlaceholder: string; query: string; onQuery: (value: string) => void; children: ReactNode }) {
  return (
    <div className="resourcePickerPopover">
      <label className="resourcePickerSearch">
        <Search size={17} aria-hidden="true" />
        <span className="srOnly">Search options</span>
        <input value={query} onChange={(event) => onQuery(event.target.value)} placeholder={searchPlaceholder} autoFocus />
      </label>
      <div className="resourcePickerOptions" role="listbox">{children}</div>
    </div>
  );
}

function PickerEmpty() {
  return <div className="resourcePickerEmpty">No matches</div>;
}

function filterOptions(options: ResourcePickerOption[], query: string) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return options;
  return options.filter((option) => [option.id, option.title, option.subtitle, option.badge].filter(Boolean).some((value) => value!.toLowerCase().includes(normalized)));
}

function useDismissPicker(rootRef: React.RefObject<HTMLDivElement | null>, open: boolean, dismiss: () => void) {
  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) dismiss();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dismiss();
    };
    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [dismiss, open, rootRef]);
}
