/**
 * Where the merchant API key lives while the console is open.
 *
 * sessionStorage, not localStorage — deliberately. The key is a CREDENTIAL: it dies with
 * the tab and does not linger on a shared machine. The theme preference goes to
 * localStorage instead (lib/theme.ts), because a colour scheme is not a secret and
 * should survive a restart. Same API, opposite lifetime, for opposite reasons.
 *
 * Neither is a production auth story; a real console would use a session cookie issued
 * after a login. For a demo, asking the operator to paste the key they just minted is
 * the smallest honest thing that works.
 */

const KEY_STORAGE = 'agentgateway.merchant_api_key';

export const GATEWAY_URL = process.env.NEXT_PUBLIC_GATEWAY_URL ?? 'http://localhost:3000';

export function getApiKey(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage.getItem(KEY_STORAGE);
  } catch {
    return null;
  }
}

export function setApiKey(key: string): void {
  try {
    window.sessionStorage.setItem(KEY_STORAGE, key.trim());
  } catch {
    // Private mode or blocked storage: the key stays in memory for this render only.
  }
}

export function clearApiKey(): void {
  try {
    window.sessionStorage.removeItem(KEY_STORAGE);
  } catch {
    // Nothing to do — the key was never persisted.
  }
}
