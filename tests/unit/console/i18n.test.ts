import { describe, expect, it } from 'vitest';

import { resources } from '../../../apps/console/src/i18n/resources';
import { resolveLanguage } from '../../../apps/console/src/i18n';

type Tree = { [key: string]: string | Tree };

function keyPaths(tree: Tree, prefix = ''): string[] {
  return Object.entries(tree).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof value === 'string' ? [path] : keyPaths(value, path);
  });
}

describe('console i18n resources', () => {
  const en = resources.en;
  const zh = resources['zh-CN'];

  it('exposes the same namespaces in English and Simplified Chinese', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
  });

  it.each(Object.keys(en))('keeps %s keys in sync between en and zh-CN', (namespace) => {
    const enKeys = keyPaths(en[namespace as keyof typeof en] as Tree).sort();
    const zhKeys = keyPaths(zh[namespace as keyof typeof zh] as Tree).sort();
    expect(zhKeys).toEqual(enKeys);
  });
});

describe('resolveLanguage', () => {
  it('honours a stored supported language', () => {
    expect(resolveLanguage('zh-CN')).toBe('zh-CN');
    expect(resolveLanguage('en')).toBe('en');
  });

  it('maps a stored legacy zh tag onto zh-CN', () => {
    expect(resolveLanguage('zh')).toBe('zh-CN');
  });

  it('defaults to English without a stored choice', () => {
    expect(resolveLanguage(null)).toBe('en');
    expect(resolveLanguage('fr-FR')).toBe('en');
  });
});
