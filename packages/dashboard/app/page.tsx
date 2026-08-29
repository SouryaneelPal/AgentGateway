import Link from 'next/link';

const SCREENS = [
  {
    href: '/policy',
    label: 'Policy console',
    note: 'Spend caps, blocked categories, enabled protocols',
  },
  {
    href: '/transactions',
    label: 'Transaction & audit feed',
    note: 'Live SSE feed across all protocols',
  },
  { href: '/agents', label: 'Agent management', note: 'Trust levels and one-click revoke' },
  {
    href: '/protocol-tester',
    label: 'Protocol tester',
    note: 'validate → normalize → settle → receipt, live',
  },
] as const;

export default function OverviewPage() {
  return (
    <section className="max-w-3xl">
      <h1 className="text-2xl font-semibold tracking-tight">Merchant Console</h1>
      <p className="mt-3 text-sm leading-relaxed text-ink-muted">
        AgentGateway normalizes x402, AP2 and fallback agent requests into one internal shape,
        enforces merchant guardrails centrally, and settles through Razorpay. The protocol layer
        proposes; Razorpay&rsquo;s webhook confirms.
      </p>

      <ul className="mt-8 grid gap-3 sm:grid-cols-2">
        {SCREENS.map((screen) => (
          <li key={screen.href}>
            <Link
              href={screen.href}
              className="block rounded-lg border border-edge bg-surface-raised p-4 transition-colors hover:border-accent"
            >
              <span className="text-sm font-medium">{screen.label}</span>
              <span className="mt-1 block text-xs text-ink-muted">{screen.note}</span>
            </Link>
          </li>
        ))}
      </ul>

      <p className="mt-8 text-xs text-ink-muted">
        This is the Phase 1 scaffold. All four screens are Phase 5 deliverables.
      </p>
    </section>
  );
}
