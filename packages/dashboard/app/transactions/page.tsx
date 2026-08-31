'use client';

import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import {
  getAuditLog,
  listTransactions,
  openStream,
  type AuditEntry,
  type Transaction,
} from '../../lib/api-client';
import {
  Card,
  EmptyState,
  Money,
  Mono,
  PageHeader,
  ProtocolTag,
  RawToggle,
  StatusTag,
} from '../../components/primitives';

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

  useEffect(() => {
    let cancelled = false;
    void getAuditLog(paymentRequestId)
      .then((result) => {
        if (!cancelled) setEntries(result.entries);
      })
      .catch(() => {
        if (!cancelled) setEntries([]);
      });
    return () => {
      cancelled = true;
    };
  }, [paymentRequestId]);

  if (entries === null) {
    return (
      <p className="t-small px-4 py-3" style={{ color: 'var(--color-ink-faint)' }}>
        Loading the decision trail…
      </p>
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

export default function TransactionsPage() {
  const [rows, setRows] = useState<Transaction[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<Set<string>>(new Set());
  const streamRef = useRef<EventSource | null>(null);

  const refresh = useCallback(async () => {
    try {
      const result = await listTransactions();
      setRows(result.transactions);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load transactions.');
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Live feed. Every audit event means something changed, so re-read the list and mark
  // whatever is new so the eye can find it.
  useEffect(() => {
    const source = openStream();
    streamRef.current = source;

    source.addEventListener('connected', () => setLive(true));
    source.addEventListener('audit', (event) => {
      const payload = JSON.parse((event as MessageEvent<string>).data) as {
        payment_request_id: string | null;
      };
      if (payload.payment_request_id !== null) {
        setFlash((current) => new Set(current).add(payload.payment_request_id as string));
      }
      void refresh();
    });
    source.onerror = () => setLive(false);

    return () => {
      source.close();
      streamRef.current = null;
    };
  }, [refresh]);

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
            {live ? 'Live' : 'Reconnecting'}
          </span>
        }
      />

      {error !== null && (
        <p className="t-small mt-4" style={{ color: 'var(--color-danger)' }}>
          {error}
        </p>
      )}

      <Card className="mt-6 overflow-hidden">
        {rows.length === 0 ? (
          <EmptyState
            title="No transactions yet"
            hint="Run the reference agent, or trigger a request from the protocol tester."
          />
        ) : (
          <table className="w-full border-collapse">
            <thead>
              <tr
                className="border-b text-left"
                style={{ borderColor: 'var(--color-edge)', background: 'var(--color-sunken)' }}
              >
                {['Time', 'Protocol', 'Amount', 'Status', 'Agent', 'Razorpay order', ''].map(
                  (heading) => (
                    <th
                      key={heading}
                      className="t-micro px-4 py-2.5 font-semibold"
                      style={{ color: 'var(--color-ink-faint)' }}
                    >
                      {heading}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const open = expanded === row.payment_request_id;
                return (
                  <Fragment key={row.payment_request_id}>
                    <tr
                      onClick={() => setExpanded(open ? null : row.payment_request_id)}
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
                      <td
                        className="t-micro px-4 py-2.5 text-right"
                        style={{ color: 'var(--color-accent)' }}
                      >
                        {open ? 'Hide' : 'Why?'}
                      </td>
                    </tr>
                    {open && (
                      <tr>
                        <td colSpan={7} style={{ background: 'var(--color-sunken)' }}>
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
        )}
      </Card>
    </div>
  );
}
