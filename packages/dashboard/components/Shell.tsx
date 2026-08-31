'use client';

import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { applyTheme, readStoredTheme, systemTheme, type Theme } from '../lib/theme';
import { clearApiKey, getApiKey, setApiKey } from '../lib/session';
import { Button } from './primitives';

const NAV = [
  { href: '/policy', label: 'Policy', hint: 'Guardrails' },
  { href: '/transactions', label: 'Transactions', hint: 'Live feed' },
  { href: '/agents', label: 'Agents', hint: 'Identities' },
  { href: '/protocol-tester', label: 'Protocol tester', hint: 'Pipeline' },
] as const;

function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('light');

  useEffect(() => {
    setTheme(readStoredTheme() ?? systemTheme());
  }, []);

  const toggle = useCallback(() => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    applyTheme(next);
  }, [theme]);

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
      className="t-micro border px-2 py-1"
      style={{
        borderColor: 'var(--color-edge-strong)',
        color: 'var(--color-ink-muted)',
        borderRadius: 'var(--radius-sm)',
      }}
    >
      {theme === 'dark' ? 'Dark' : 'Light'}
    </button>
  );
}

/**
 * The door. No key, no console.
 *
 * The operator pastes the key minted by `npm run merchant:create`. It is held in
 * sessionStorage, so it dies with the tab — see lib/session.ts.
 */
function KeyGate({ onUnlock }: { onUnlock: () => void }) {
  const [value, setValue] = useState('');

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
      <p className="t-micro" style={{ color: 'var(--color-accent)' }}>
        AgentGateway
      </p>
      <h1 className="t-display mt-2">Merchant console</h1>
      <p className="t-body mt-2" style={{ color: 'var(--color-ink-muted)' }}>
        Paste the API key for your merchant account to continue. It is kept for this browser tab
        only and is never written to disk.
      </p>

      <form
        className="mt-6"
        onSubmit={(event) => {
          event.preventDefault();
          if (value.trim().length === 0) return;
          setApiKey(value);
          onUnlock();
        }}
      >
        <label className="t-micro block" style={{ color: 'var(--color-ink-muted)' }} htmlFor="key">
          Merchant API key
        </label>
        <input
          id="key"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="agk_…"
          autoComplete="off"
          spellCheck={false}
          className="tnum mt-1.5 w-full border px-3 py-2 text-sm"
          style={{
            background: 'var(--color-raised)',
            borderColor: 'var(--color-edge-strong)',
            color: 'var(--color-ink)',
            borderRadius: 'var(--radius-md)',
          }}
        />
        <div className="mt-3">
          <Button type="submit" variant="accent">
            Open console
          </Button>
        </div>
      </form>

      <p className="t-small mt-8" style={{ color: 'var(--color-ink-faint)' }}>
        Don&rsquo;t have one? Run{' '}
        <code className="tnum">npm run merchant:create --workspace=gateway</code> and copy the key
        it prints.
      </p>
    </main>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [unlocked, setUnlocked] = useState<boolean | null>(null);

  useEffect(() => {
    setUnlocked(getApiKey() !== null);
  }, []);

  // Nothing renders until we know — avoids flashing the console to someone without a key.
  if (unlocked === null) return null;
  if (!unlocked) return <KeyGate onUnlock={() => setUnlocked(true)} />;

  return (
    <div className="flex min-h-screen">
      <aside
        className="flex w-56 shrink-0 flex-col border-r"
        style={{ borderColor: 'var(--color-edge)', background: 'var(--color-raised)' }}
      >
        <div className="px-5 py-5">
          <p className="t-micro" style={{ color: 'var(--color-accent)' }}>
            AgentGateway
          </p>
          <p className="t-title mt-0.5">Console</p>
        </div>

        <nav className="flex-1 px-2">
          {NAV.map((item) => {
            const active = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                className="mb-0.5 block px-3 py-2 transition-colors"
                style={{
                  background: active ? 'var(--color-accent-ground)' : 'transparent',
                  color: active ? 'var(--color-accent)' : 'var(--color-ink-muted)',
                  borderRadius: 'var(--radius-sm)',
                  boxShadow: active ? 'inset 2px 0 0 var(--color-accent)' : 'none',
                }}
              >
                <span className="t-small block font-medium">{item.label}</span>
                <span className="t-micro" style={{ opacity: 0.65 }}>
                  {item.hint}
                </span>
              </Link>
            );
          })}
        </nav>

        <div
          className="flex items-center justify-between border-t px-4 py-3"
          style={{ borderColor: 'var(--color-edge)' }}
        >
          <ThemeToggle />
          <button
            type="button"
            onClick={() => {
              clearApiKey();
              setUnlocked(false);
            }}
            className="t-micro"
            style={{ color: 'var(--color-ink-faint)' }}
          >
            Sign out
          </button>
        </div>
      </aside>

      <main className="min-w-0 flex-1 px-8 py-7">{children}</main>
    </div>
  );
}
