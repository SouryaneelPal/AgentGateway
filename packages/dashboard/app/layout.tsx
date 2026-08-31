import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { IBM_Plex_Mono, IBM_Plex_Sans } from 'next/font/google';
import { Shell } from '../components/Shell';
import { THEME_BOOTSTRAP } from '../lib/theme';
import './globals.css';

/**
 * IBM Plex, for a reason: it was drawn for technical and data-dense interfaces, which is
 * exactly what a settlement console is. Mono carries every figure, identifier and hash.
 */
const sans = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-plex-sans',
  display: 'swap',
});

const mono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-plex-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'AgentGateway — Merchant Console',
  description: 'Guardrails, settlement and audit trail for agent-initiated payments.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={`${sans.variable} ${mono.variable}`}>
      <head>
        {/* Sets the theme before first paint so the wrong one never flashes. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body>
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
