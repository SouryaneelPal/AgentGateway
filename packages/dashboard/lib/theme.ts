/**
 * Theme handling.
 *
 * A real toggle, not just prefers-color-scheme: the operator's explicit choice wins and
 * persists in localStorage. System preference is only the starting point when no choice
 * has been made yet.
 */

export type Theme = 'light' | 'dark';

const THEME_STORAGE = 'agentgateway.theme';

export function readStoredTheme(): Theme | null {
  try {
    const value = window.localStorage.getItem(THEME_STORAGE);
    return value === 'light' || value === 'dark' ? value : null;
  } catch {
    return null;
  }
}

export function systemTheme(): Theme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme);
  try {
    window.localStorage.setItem(THEME_STORAGE, theme);
  } catch {
    // Persisting is a convenience; the attribute above is what actually renders.
  }
}

/**
 * Runs before paint, inlined in <head>, to stop the wrong theme flashing on load.
 * Deliberately dependency-free and stringified — it executes before React exists.
 */
export const THEME_BOOTSTRAP = `(function(){try{var s=localStorage.getItem('${THEME_STORAGE}');var t=(s==='light'||s==='dark')?s:(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');document.documentElement.setAttribute('data-theme',t);}catch(e){document.documentElement.setAttribute('data-theme','light');}})()`;
