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
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'default' | 'accent' | 'danger';
  disabled?: boolean;
  type?: 'button' | 'submit';
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
            borderColor: 'var(--color-edge-strong)',
          };

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className="t-small border px-3 py-1.5 font-medium transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
      style={{ ...style, borderRadius: 'var(--radius-md)' }}
    >
      {children}
    </button>
  );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div
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
