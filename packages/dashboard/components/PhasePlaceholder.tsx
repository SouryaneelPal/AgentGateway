/**
 * Every dashboard screen is Phase 5 work. Rather than shipping five empty files, each
 * page states what it will do and which whitepaper section specifies it — so the
 * scaffold is readable as a plan instead of as an unfinished app.
 */

export interface PhasePlaceholderProps {
  readonly title: string;
  readonly phase: string;
  readonly spec: string;
  readonly bullets: readonly string[];
}

export function PhasePlaceholder({ title, phase, spec, bullets }: PhasePlaceholderProps) {
  return (
    <section className="max-w-3xl">
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <span className="rounded-full border border-edge px-2.5 py-0.5 text-xs text-ink-muted">
          {phase}
        </span>
      </div>
      <p className="mt-2 text-sm text-ink-muted">Specified in {spec}.</p>
      <ul className="mt-6 space-y-2.5">
        {bullets.map((bullet) => (
          <li key={bullet} className="flex gap-3 text-sm leading-relaxed">
            <span aria-hidden className="mt-2 h-1 w-1 shrink-0 rounded-full bg-accent" />
            <span>{bullet}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
