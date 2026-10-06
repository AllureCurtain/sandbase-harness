import type { RuntimeSettingsConfig } from '../../../types';
import { ConsoleSelect } from '../../console-select';

export type AdapterOption = {
  id: string;
  label: string;
  status: 'available' | 'unavailable' | 'invalid';
  options_schema?: Record<string, unknown>;
};

export type SettingsFormProps = {
  adapters: AdapterOption[];
  config: RuntimeSettingsConfig;
  onChange: (config: RuntimeSettingsConfig) => void;
  errors?: Record<string, string>;
  resetKey?: number;
};

export function AdapterSelect({
  adapters,
  value,
  onChange,
  label,
}: {
  adapters: AdapterOption[];
  value: string;
  onChange: (value: string) => void;
  label: string;
}) {
  return (
    <ConsoleSelect
      label={label}
      value={value}
      onChange={onChange}
      options={adapters.map((item) => ({
        value: item.id,
        label: item.status === 'available' ? item.label : `${item.label} · ${item.status}`,
        disabled: item.status !== 'available',
      }))}
    />
  );
}

export function optionDefaultsForAdapter(
  adapters: Array<{ id: string; options_schema?: Record<string, unknown> }>,
  id: string,
): Record<string, unknown> {
  const schema = adapters.find((adapter) => adapter.id === id)?.options_schema;
  if (!schema || typeof schema !== 'object') return {};
  const properties = (schema as { properties?: unknown }).properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return {};
  return Object.fromEntries(Object.entries(properties as Record<string, unknown>).flatMap(([key, value]) => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !('default' in value)) return [];
    return [[key, (value as { default: unknown }).default]];
  }));
}
