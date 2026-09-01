'use client';

import type { ReactNode } from 'react';

/**
 * Status and protocol tags.
 *
 * Colour is never the only signal: each tag carries a leading glyph and its own word, so
 * the distinction survives greyscale and colour-blindness. That is a requirement here,
 * not a nicety — telling "settled" from "rejected" at a glance is the whole job.
 */
const STATUS_META: Record<string, { label: string; glyph: string; fg: string; bg: string }> = {
  settled: { label: 'Settled', glyph: '●', fg: 'var(--color-ok)', bg: 'var(--color-ok-ground)' },
  awaiting_settlement: {
    label: 'Awaiting',
    glyph: '◐',
    fg: 'var(--color-warn)',
    bg: 'var(--color-warn-ground)',
  },
  pending: {
    label: 'Pending',
    glyph: '○',
    fg: 'var(--color-neutral)',
    bg: 'var(--color-neutral-ground)',
  },
  rejected: {
    label: 'Rejected',
    glyph: '✕',
    fg: 'var(--color-danger)',
    bg: 'var(--color-danger-ground)',
  },
  failed: {
    label: 'Failed',
    glyph: '!',
    fg: 'var(--color-danger)',
    bg: 'var(--color-danger-ground)',
  },
};

export function StatusTag({ status }: { status: string }) {
  const meta = STATUS_META[status] ?? {
    label: status,
    glyph: '·',
    fg: 'var(--color-neutral)',
    bg: 'var(--color-neutral-ground)',
  };
  return (
    <span
      className="t-micro inline-flex items-center gap-1.5 px-1.5 py-0.5"
      style={{ color: meta.fg, backgroundColor: meta.bg, borderRadius: 'var(--radius-sm)' }}
    >
      <span aria-hidden>{meta.glyph}</span>
      {meta.label}
    </span>
  );
}

/** Protocol origin. Distinguished by its own letterform, not by hue. */
export function ProtocolTag({ protocol }: { protocol: string }) {
  const mark = protocol === 'x402' ? '402' : protocol === 'ap2' ? 'AP2' : 'FBK';
  return (
    <span
      className="t-micro inline-flex items-center border px-1.5 py-0.5 font-mono"
      style={{
        borderColor: 'var(--color-edge-strong)',
        color: 'var(--color-ink-muted)',
        borderRadius: 'var(--radius-sm)',
      }}
      title={protocol}
    >
      {mark}
    </span>
  );
}

/** Money. Always mono, always tabular, always explicit about the unit. */
export function Money({ paise }: { paise: number }) {
  return (
    <span className="tnum">
      ₹
      {(paise / 100).toLocaleString('en-IN', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}
    </span>
  );
}

/** Identifiers and hashes: mono, truncated to a readable head, full value on hover. */
export function Mono({ value, chars = 14 }: { value: string | null; chars?: number }) {
  if (value === null || value.length === 0) {
    return <span style={{ color: 'var(--color-ink-faint)' }}>—</span>;
  }
  const shown = value.length > chars ? `${value.slice(0, chars)}…` : value;
  return (
    <span className="tnum t-small" title={value} style={{ color: 'var(--color-ink-muted)' }}>
      {shown}
    </span>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return (
    <header
      className="flex flex-wrap items-start justify-between gap-4 border-b pb-5"
      style={{ borderColor: 'var(--color-edge)' }}
    >
      <div className="max-w-2xl">
        <h1 className="t-display">{title}</h1>
        <p className="t-body mt-1.5" style={{ color: 'var(--color-ink-muted)' }}>
          {description}
        </p>
      </div>
      {actions !== undefined && <div className="flex items-center gap-2">{actions}</div>}
    </header>
  );
}

export function Button({
  children,
  onClick,
  variant = 'default',
  disabled = false,
  type = 'button',
  ariaLabel,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'default' | 'accent' | 'danger';
  disabled?: boolean;
  type?: 'button' | 'submit';
  /** For buttons whose visible label repeats across rows and needs the row's subject. */
  ariaLabel?: string;
}) {
  const style =
    variant === 'accent'
      ? { background: 'var(--color-accent)', color: '#fff', borderColor: 'var(--color-accent)' }
      : variant === 'danger'
        ? {
            background: 'transparent',
            color: 'var(--color-danger)',
            borderColor: 'var(--color-danger)',
          }
        : {
            background: 'var(--color-raised)',
            color: 'var(--color-ink)',
            // A button's border is what identifies it as a button — 3:1 per WCAG 1.4.11.
            borderColor: 'var(--color-control-edge)',
          };

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      className="t-small border px-3 py-1.5 font-medium transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
      style={{ ...style, borderRadius: 'var(--radius-md)' }}
    >
      {children}
    </button>
  );
}

export function Card({
  children,
  className = '',
  role,
  ariaLive,
  ariaLabel,
}: {
  children: ReactNode;
  className?: string;
  role?: string;
  ariaLive?: 'polite' | 'assertive';
  ariaLabel?: string;
}) {
  return (
    <div
      role={role}
      aria-live={ariaLive}
      aria-label={ariaLabel}
      className={`border ${className}`}
      style={{
        background: 'var(--color-raised)',
        borderColor: 'var(--color-edge)',
        borderRadius: 'var(--radius-lg)',
      }}
    >
      {children}
    </div>
  );
}

export function EmptyState({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="px-4 py-14 text-center">
      <p className="t-body font-medium">{title}</p>
      <p className="t-small mt-1" style={{ color: 'var(--color-ink-muted)' }}>
        {hint}
      </p>
    </div>
  );
}

/**
 * A placeholder bar. Deliberately not shaped like real content — a skeleton that mimics
 * the data too closely is just a slower way of showing something untrue.
 */
export function Skeleton({ width = '100%', height = 12 }: { width?: string; height?: number }) {
  return <span className="skeleton block" style={{ width, height }} />;
}

/**
 * Loading placeholder for a table.
 *
 * This exists because the alternative is worse than a blank screen: every list here
 * started as `useState([])`, so the FIRST paint rendered the "no data yet" empty state
 * and then swapped in rows a moment later. A merchant with a full ledger was briefly
 * told they had nothing — a false statement about their money, not just a flicker.
 */
export function TableSkeleton({ columns, rows = 5 }: { columns: string[]; rows?: number }) {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading…</span>
      <table className="w-full border-collapse">
        <thead>
          <tr
            className="border-b text-left"
            style={{ borderColor: 'var(--color-edge)', background: 'var(--color-sunken)' }}
          >
            {columns.map((heading) => (
              <th
                key={heading}
                scope="col"
                className="t-micro px-4 py-2.5 font-semibold"
                style={{ color: 'var(--color-ink-faint)' }}
              >
                {heading}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rows }, (_, row) => (
            <tr key={row} className="border-b" style={{ borderColor: 'var(--color-edge)' }}>
              {columns.map((heading, column) => (
                <td key={heading} className="px-4 py-3.5">
                  <Skeleton width={column === 0 ? '70%' : column % 2 === 0 ? '45%' : '60%'} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Loading placeholder for the stacked cards on the policy screen. */
export function FormSkeleton({ cards = 3 }: { cards?: number }) {
  return (
    <div className="space-y-5" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading…</span>
      {Array.from({ length: cards }, (_, index) => (
        <Card key={index} className="p-5">
          <Skeleton width="38%" height={15} />
          <div className="mt-3">
            <Skeleton width="80%" />
          </div>
          <div className="mt-4">
            <Skeleton width="45%" height={30} />
          </div>
        </Card>
      ))}
    </div>
  );
}

/**
 * Something went wrong and the user can do something about it.
 *
 * Always offers the retry, because the overwhelmingly common cause here is the gateway
 * not being up yet. A dead end with no way forward would make the operator reload the
 * whole console, which loses the session key with it.
 */
export function ErrorState({
  title,
  detail,
  onRetry,
  retrying = false,
}: {
  title: string;
  detail: string;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  return (
    <div className="px-4 py-12 text-center" role="alert">
      <p className="t-body font-medium" style={{ color: 'var(--color-danger)' }}>
        <span aria-hidden>✕ </span>
        {title}
      </p>
      <p className="t-small mx-auto mt-1.5 max-w-md" style={{ color: 'var(--color-ink-muted)' }}>
        {detail}
      </p>
      {onRetry !== undefined && (
        <div className="mt-4">
          <Button onClick={onRetry} disabled={retrying}>
            {retrying ? 'Retrying…' : 'Try again'}
          </Button>
        </div>
      )}
    </div>
  );
}

/** Inline banner for a non-blocking error — the screen still has content behind it. */
export function InlineError({ message }: { message: string }) {
  return (
    <p
      role="alert"
      className="t-small mt-4 border px-3 py-2"
      style={{
        color: 'var(--color-danger)',
        background: 'var(--color-danger-ground)',
        borderColor: 'var(--color-danger)',
        borderRadius: 'var(--radius-md)',
      }}
    >
      {message}
    </p>
  );
}

/** Inline banner for a completed action. */
export function InlineNotice({ message }: { message: string }) {
  return (
    <p
      role="status"
      className="t-small mt-4 border px-3 py-2"
      style={{
        color: 'var(--color-ok)',
        background: 'var(--color-ok-ground)',
        borderColor: 'var(--color-ok)',
        borderRadius: 'var(--radius-md)',
      }}
    >
      {message}
    </p>
  );
}

/** Raw payload, behind a toggle — plain language first, JSON for whoever wants it. */
export function RawToggle({ label = 'View raw', data }: { label?: string; data: unknown }) {
  return (
    <details className="mt-2">
      <summary
        className="t-small cursor-pointer select-none"
        style={{ color: 'var(--color-ink-faint)' }}
      >
        {label}
      </summary>
      <pre
        className="tnum mt-2 overflow-x-auto p-3 text-[11px] leading-relaxed"
        style={{
          background: 'var(--color-sunken)',
          borderRadius: 'var(--radius-sm)',
          color: 'var(--color-ink-muted)',
        }}
      >
        {JSON.stringify(data, null, 2)}
      </pre>
    </details>
  );
}
