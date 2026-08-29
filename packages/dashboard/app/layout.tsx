import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: 'AgentGateway — Merchant Console',
  description: 'Protocol-agnostic guardrails and audit trail for agent-initiated payments.',
};

const NAV = [
  { href: '/', label: 'Overview' },
  { href: '/policy', label: 'Policy' },
  { href: '/transactions', label: 'Transactions' },
  { href: '/agents', label: 'Agents' },
  { href: '/protocol-tester', label: 'Protocol Tester' },
] as const;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <div className="mx-auto flex min-h-screen max-w-6xl flex-col px-6">
          <header className="flex flex-wrap items-center gap-x-6 gap-y-3 border-b border-edge py-5">
            <span className="text-sm font-semibold tracking-tight">AgentGateway</span>
            <nav className="flex flex-wrap gap-x-5 gap-y-2 text-sm text-ink-muted">
              {NAV.map((item) => (
                <Link key={item.href} href={item.href} className="hover:text-ink">
                  {item.label}
                </Link>
              ))}
            </nav>
          </header>
          <main className="flex-1 py-10">{children}</main>
          <footer className="border-t border-edge py-5 text-xs text-ink-muted">
            Phase 1 scaffold — screens land in Phase 5. See ROADMAP.md.
          </footer>
        </div>
      </body>
    </html>
  );
}
