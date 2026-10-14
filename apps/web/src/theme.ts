export type Theme = 'dark' | 'light';
export const THEME_STORAGE_KEY = 'confidence.theme';
export const THEME_COLORS: Record<Theme, string> = { dark: '#111315', light: '#f6f7f9' };

export function resolveTheme(value: unknown): Theme {
  return value === 'light' ? 'light' : 'dark';
}

export function readTheme(storage: () => Pick<Storage, 'getItem'> = () => window.localStorage): Theme {
  try { return resolveTheme(storage().getItem(THEME_STORAGE_KEY)); }
  catch { return 'dark'; }
}

export function saveTheme(theme: Theme, storage: () => Pick<Storage, 'setItem'> = () => window.localStorage): void {
  // A blocked or full preference store must not prevent changing this page.
  try { storage().setItem(THEME_STORAGE_KEY, theme); }
  catch { /* The active page still uses the selected theme. */ }
}

export function applyTheme(theme: Theme, target: Document = document): void {
  target.documentElement.dataset.theme = theme;
  target.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLORS[theme]);
}
