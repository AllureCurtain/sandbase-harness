export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'sandbase-console.theme';

export function readThemePreference(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
  }
  return 'system';
}

function systemTheme(): ResolvedTheme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  return preference === 'system' ? systemTheme() : preference;
}

/** `data-theme` drives the console's own tokens; the `dark` class drives
 *  Beautiful UI and Tailwind's `dark:` variant — both are set together. */
export function applyTheme(theme: ResolvedTheme): void {
  document.documentElement.dataset.theme = theme;
  document.documentElement.classList.toggle('dark', theme === 'dark');
  document.documentElement.style.colorScheme = theme;
}

/** Applies the stored-or-system theme and follows OS changes while the
 *  preference is `system`. Returns the unsubscribe for tests. */
export function initTheme(onChange?: (theme: ResolvedTheme) => void): () => void {
  const apply = () => {
    const resolved = resolveTheme(readThemePreference());
    applyTheme(resolved);
    onChange?.(resolved);
  };
  apply();
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const onMedia = () => {
    if (readThemePreference() === 'system') apply();
  };
  media.addEventListener('change', onMedia);
  const onStorage = (event: StorageEvent) => {
    if (event.key === THEME_STORAGE_KEY || event.key === null) apply();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    media.removeEventListener('change', onMedia);
    window.removeEventListener('storage', onStorage);
  };
}
