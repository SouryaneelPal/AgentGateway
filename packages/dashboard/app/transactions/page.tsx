'use client';

import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import {
  describeFailure,
  getAuditLog,
  listTransactions,
  openStream,
  type AuditEntry,
  type Transaction,
} from '../../lib/api-client';
import {
  Card,
  EmptyState,
  ErrorState,
  InlineError,
  Money,
  Mono,
  PageHeader,
  ProtocolTag,
  RawToggle,
  StatusTag,
  TableSkeleton,
} from '../../components/primitives';

const COLUMNS = ['Time', 'Protocol', 'Amount', 'Status', 'Agent', 'Razorpay order', ''];

function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-IN', { hour12: false });
}

/**
 * The decision trail for one request.
 *
 * Plain language first — the Phase 5 bar is that someone non-technical can read this
 * without opening logs. The raw payload stays one click away for whoever wants it.
 */
function AuditTrail({ paymentRequestId }: { paymentRequestId: string }) {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const load = useCallback(() => {
    setFailed(null);
    setEntries(null);
    let cancelled = false;
    void getAuditLog(paymentRequestId)
      .then((result) => {
        if (!cancelled) setEntries(result.entries);
      })
      .catch((cause: unknown) => {
        // Previously this swallowed the error and set an empty list, so a failed fetch
        // was indistinguishable from a request that genuinely had no audit trail — the
        // console asserted "nothing recorded" when it simply had not managed to look.
        if (!cancelled) setFailed(describeFailure(cause, 'Could not load the decision trail.'));
      });
    return () => {
      cancelled = true;
    };
  }, [paymentRequestId]);

  useEffect(() => load(), [load]);

  if (failed !== null) {
    return <ErrorState title="Could not load the decision trail" detail={failed} onRetry={load} />;
  }

  if (entries === null) {
    return (
      <div className="px-4 py-3" aria-busy="true">
        <span className="sr-only">Loading the decision trail…</span>
        <div className="space-y-2">
          <span className="skeleton block" style={{ width: '60%', height: 12 }} />
          <span className="skeleton block" style={{ width: '40%', height: 10 }} />
        </div>
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <p className="t-small px-4 py-3" style={{ color: 'var(--color-ink-faint)' }}>
        Nothing recorded for this request yet.
      </p>
    );
  }

  return (
    <ol className="px-4 py-3">
      {entries.map((entry, index) => (
        <li key={entry.id} className="relative pb-4 pl-6 last:pb-0">
          {index < entries.length - 1 && (
            <span
              aria-hidden
              className="absolute left-[5px] top-4 h-full w-px"
              style={{ background: 'var(--color-edge-strong)' }}
            />
          )}
          <span
            aria-hidden
            className="absolute left-0 top-1.5 h-[11px] w-[11px] border"
            style={{
              background: 'var(--color-surface)',
              borderColor: 'var(--color-accent)',
              borderRadius: '50%',
            }}
          />
          <p className="t-body">{entry.explanation}</p>
          <p className="t-micro mt-1" style={{ color: 'var(--color-ink-faint)' }}>
            {entry.actor_type} · {timeOf(entry.created_at)}
          </p>
          <RawToggle data={entry.detail} />
        </li>
      ))}
    </ol>
  );
}

type Phase = 'loading' | 'ready' | 'failed';

export default function TransactionsPage() {
  const [phase, setPhase] = useState<Phase>('loading');
  const [rows, setRows] = useState<Transaction[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<Set<string>>(new Set());
  const streamRef = useRef<EventSource | null>(null);

  const refresh = useCallback(async (retry = false) => {
    if (retry) setPhase('loading');
    try {
      const result = await listTransactions();
      setRows(result.transactions);
      setError(null);
      setPhase('ready');
    } catch (cause) {
      const message = describeFailure(cause, 'Could not load transactions.');
      setError(message);
      // Only take over the whole screen if there is nothing to show. Once rows are on
      // screen a failed background refresh is a banner, not a demolition.
      setPhase((current) => (current === 'ready' ? 'ready' : 'failed'));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * Live feed. Every audit event means something changed, so re-read the list and mark
   * whatever is new so the eye can find it.
   *
   * Reconnection is handled HERE rather than left to EventSource.
   *
   * EventSource retries on its own, and against a gateway that is down it does so
   * relentlessly: with the gateway stopped, one idle tab produced 137 refused requests
   * in about a minute. That is a retry storm, and it is the same failure as a spinner
   * that never resolves — the console looks calm while hammering a dead socket. So the
   * stream is closed on the first error and reopened on our own exponential backoff,
   * capped at 30s, resetting once a connection succeeds.
   */
  useEffect(() => {
    let source: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;
    let stopped = false;

    const connect = () => {
      if (stopped) return;

      const next = openStream();
      source = next;
      streamRef.current = next;

      next.addEventListener('connected', () => {
        attempts = 0;
        setLive(true);
      });

      next.addEventListener('audit', (event) => {
        try {
          const payload = JSON.parse((event as MessageEvent<string>).data) as {
            payment_request_id: string | null;
          };
          if (payload.payment_request_id !== null) {
            setFlash((current) => new Set(current).add(payload.payment_request_id as string));
          }
        } catch {
          // A malformed frame must not take the feed down; the refresh below still runs.
        }
        void refresh();
      });

      next.onerror = () => {
        setLive(false);
        next.close();
        if (source === next) source = null;
        attempts += 1;
        const delay = Math.min(30_000, 1_000 * 2 ** Math.min(attempts, 5));
        timer = setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      source?.close();
      streamRef.current = null;
    };
  }, [refresh]);

  const toggle = (id: string) => setExpanded((current) => (current === id ? null : id));

  return (
    <div>
      <PageHeader
        title="Transactions"
        description="Every agent payment request, whichever protocol it arrived on. Select a row to see why the gateway allowed or refused it."
        actions={
          <span
            className="t-micro inline-flex items-center gap-1.5 border px-2 py-1"
            style={{
              borderColor: live ? 'var(--color-ok)' : 'var(--color-edge-strong)',
              color: live ? 'var(--color-ok)' : 'var(--color-ink-faint)',
              borderRadius: 'var(--radius-sm)',
            }}
          >
            <span aria-hidden>{live ? '●' : '○'}</span>
            <span role="status">{live ? 'Live' : 'Reconnecting'}</span>
          </span>
        }
      />

      {/* A failed refresh while rows are already on screen: say so, keep the data. */}
      {phase === 'ready' && error !== null && <InlineError message={error} />}

      <Card className="mt-6 overflow-hidden">
        {phase === 'loading' ? (
          <TableSkeleton columns={COLUMNS} />
        ) : phase === 'failed' ? (
          <ErrorState
            title="Could not load transactions"
            detail={error ?? 'The gateway did not answer.'}
            onRetry={() => void refresh(true)}
          />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No transactions yet"
            hint="Run the reference agent, or trigger a request from the protocol tester."
          />
        ) : (
          /* Horizontal scroll rather than clipping. The Card sets overflow-hidden for its
             rounded corners, which silently cut the last columns off at narrower widths. */
          <div className="relative overflow-x-auto">
            <table className="w-full border-collapse" style={{ minWidth: '52rem' }}>
              <caption className="sr-only">
                Agent payment requests, newest first. Each row expands to show why the gateway
                allowed or refused it.
              </caption>
              <thead>
                <tr
                  className="border-b text-left"
                  style={{ borderColor: 'var(--color-edge)', background: 'var(--color-sunken)' }}
                >
                  {COLUMNS.map((heading) => (
                    <th
                      key={heading}
                      scope="col"
                      className="t-micro px-4 py-2.5 font-semibold"
                      style={{ color: 'var(--color-ink-faint)' }}
                    >
                      {heading === '' ? <span className="sr-only">Decision trail</span> : heading}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const open = expanded === row.payment_request_id;
                  const panelId = `trail-${row.payment_request_id}`;
                  return (
                    <Fragment key={row.payment_request_id}>
                      <tr
                        onClick={() => toggle(row.payment_request_id)}
                        className={`cursor-pointer border-b ${flash.has(row.payment_request_id) ? 'row-in' : ''}`}
                        style={{
                          borderColor: 'var(--color-edge)',
                          background: open ? 'var(--color-sunken)' : 'transparent',
                        }}
                      >
                        <td
                          className="tnum t-small px-4 py-2.5"
                          style={{ color: 'var(--color-ink-muted)' }}
                        >
                          {timeOf(row.created_at)}
                        </td>
                        <td className="px-4 py-2.5">
                          <ProtocolTag protocol={row.protocol} />
                        </td>
                        <td className="t-small px-4 py-2.5">
                          <Money paise={row.amount_paise} />
                        </td>
                        <td className="px-4 py-2.5">
                          <StatusTag status={row.status} />
                        </td>
                        <td className="px-4 py-2.5">
                          <Mono value={row.external_agent_id} chars={18} />
                        </td>
                        <td className="px-4 py-2.5">
                          <Mono value={row.razorpay_order_id} chars={16} />
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          {/*
                           * A real button, not a styled table cell.
                           *
                           * The row's onClick is a mouse convenience; before this the ONLY
                           * way to open a decision trail was clicking a <tr>, which no
                           * keyboard reaches and no screen reader announces. The button
                           * carries the expanded state so assistive tech can report it.
                           */}
                          <button
                            type="button"
                            aria-expanded={open}
                            aria-controls={panelId}
                            onClick={(event) => {
                              event.stopPropagation();
                              toggle(row.payment_request_id);
                            }}
                            className="t-micro"
                            style={{ color: 'var(--color-accent)' }}
                          >
                            {open ? 'Hide' : 'Why?'}
                            <span className="sr-only">
                              {' '}
                              decision trail for {row.external_agent_id}
                            </span>
                          </button>
                        </td>
                      </tr>
                      {open && (
                        <tr id={panelId}>
                          <td
                            colSpan={COLUMNS.length}
                            style={{ background: 'var(--color-sunken)' }}
                          >
                            <div
                              className="border-l-2"
                              style={{ borderColor: 'var(--color-accent)' }}
                            >
                              {row.rejection_reason !== null && (
                                <p
                                  className="t-small px-4 pt-3"
                                  style={{ color: 'var(--color-danger)' }}
                                >
                                  Declined — {row.rejection_reason.replace(/_/g, ' ')}
                                </p>
                              )}
                              <AuditTrail paymentRequestId={row.payment_request_id} />
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
