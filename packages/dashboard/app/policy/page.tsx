'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  getPolicy,
  updatePolicy,
  type MerchantPolicy,
  type ProtocolName,
} from '../../lib/api-client';
import { Button, Card, PageHeader } from '../../components/primitives';

const ALL_PROTOCOLS: { id: ProtocolName; label: string; note: string }[] = [
  { id: 'x402', label: 'x402', note: 'HTTP 402 challenge/response' },
  { id: 'ap2', label: 'AP2', note: 'Signed intent mandates' },
  { id: 'fallback', label: 'Fallback', note: 'Payment link, human approves' },
];

export default function PolicyPage() {
  const [policy, setPolicy] = useState<MerchantPolicy | null>(null);
  const [ceiling, setCeiling] = useState('0');
  const [categories, setCategories] = useState('');
  const [protocols, setProtocols] = useState<ProtocolName[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = await getPolicy();
      setPolicy(next);
      setCeiling(String(next.max_auto_approve_paise));
      setCategories(next.blocked_categories.join(', '));
      setProtocols(next.enabled_protocols);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load your guardrails.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    setSaving(true);
    setStatus(null);
    setError(null);
    try {
      const saved = await updatePolicy({
        max_auto_approve_paise: Number(ceiling),
        blocked_categories: categories
          .split(',')
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0),
        enabled_protocols: protocols,
      });
      setPolicy(saved);
      setStatus('Guardrails saved. They apply to the next request.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save your guardrails.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-3xl">
      <PageHeader
        title="Guardrails"
        description="The rules every agent request is checked against, whichever protocol it arrives on. Changes take effect on the next request."
        actions={
          <Button onClick={() => void save()} variant="accent" disabled={saving}>
            {saving ? 'Saving…' : 'Save changes'}
          </Button>
        }
      />

      {error !== null && (
        <p
          className="t-small mt-4 border px-3 py-2"
          style={{
            color: 'var(--color-danger)',
            background: 'var(--color-danger-ground)',
            borderColor: 'var(--color-danger)',
            borderRadius: 'var(--radius-md)',
          }}
        >
          {error}
        </p>
      )}
      {status !== null && (
        <p
          className="t-small mt-4 border px-3 py-2"
          style={{
            color: 'var(--color-ok)',
            background: 'var(--color-ok-ground)',
            borderColor: 'var(--color-ok)',
            borderRadius: 'var(--radius-md)',
          }}
        >
          {status}
        </p>
      )}

      <section className="mt-7 space-y-5">
        <Card className="p-5">
          <label className="t-title block" htmlFor="ceiling">
            Approve automatically up to
          </label>
          <p className="t-small mt-1" style={{ color: 'var(--color-ink-muted)' }}>
            Anything above this needs a person to approve it. Set 0 to approve any amount
            automatically, within each agent&rsquo;s own spending limit.
          </p>
          <div className="mt-3 flex items-center gap-2">
            <span className="tnum t-body" style={{ color: 'var(--color-ink-muted)' }}>
              ₹
            </span>
            <input
              id="ceiling"
              value={ceiling}
              inputMode="numeric"
              onChange={(event) => setCeiling(event.target.value.replace(/[^0-9]/g, ''))}
              className="tnum w-44 border px-3 py-1.5 text-sm"
              style={{
                background: 'var(--color-surface)',
                borderColor: 'var(--color-edge-strong)',
                color: 'var(--color-ink)',
                borderRadius: 'var(--radius-md)',
              }}
            />
            <span className="t-small" style={{ color: 'var(--color-ink-faint)' }}>
              paise ·{' '}
              {(Number(ceiling) / 100).toLocaleString('en-IN', {
                style: 'currency',
                currency: 'INR',
              })}
            </span>
          </div>
        </Card>

        <Card className="p-5">
          <p className="t-title">Protocols you accept</p>
          <p className="t-small mt-1" style={{ color: 'var(--color-ink-muted)' }}>
            A request arriving on a protocol you have switched off is declined before any payment is
            created.
          </p>
          <div className="mt-3 space-y-2">
            {ALL_PROTOCOLS.map((protocol) => {
              const on = protocols.includes(protocol.id);
              return (
                <label key={protocol.id} className="flex cursor-pointer items-start gap-3">
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() =>
                      setProtocols((current) =>
                        current.includes(protocol.id)
                          ? current.filter((entry) => entry !== protocol.id)
                          : [...current, protocol.id],
                      )
                    }
                    className="mt-0.5"
                    style={{ accentColor: 'var(--color-accent)' }}
                  />
                  <span>
                    <span className="t-small block font-medium">{protocol.label}</span>
                    <span className="t-small" style={{ color: 'var(--color-ink-faint)' }}>
                      {protocol.note}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        </Card>

        <Card className="p-5">
          <label className="t-title block" htmlFor="categories">
            Blocked categories
          </label>
          <p className="t-small mt-1" style={{ color: 'var(--color-ink-muted)' }}>
            Comma separated. Purchases tagged with any of these are declined.
          </p>
          <input
            id="categories"
            value={categories}
            onChange={(event) => setCategories(event.target.value)}
            placeholder="gambling, alcohol"
            className="mt-3 w-full border px-3 py-1.5 text-sm"
            style={{
              background: 'var(--color-surface)',
              borderColor: 'var(--color-edge-strong)',
              color: 'var(--color-ink)',
              borderRadius: 'var(--radius-md)',
            }}
          />
        </Card>
      </section>

      {policy !== null && (
        <p className="t-small mt-6" style={{ color: 'var(--color-ink-faint)' }}>
          Merchant <span className="tnum">{policy.merchant_name ?? policy.merchant_id}</span>
        </p>
      )}
    </div>
  );
}
