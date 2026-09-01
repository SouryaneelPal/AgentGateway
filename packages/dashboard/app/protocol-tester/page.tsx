'use client';

import { useCallback, useEffect, useState } from 'react';
import { GATEWAY_URL } from '../../lib/session';
import { listAgents, getPolicy } from '../../lib/api-client';
import {
  Button,
  Card,
  ErrorState,
  Mono,
  PageHeader,
  ProtocolTag,
  RawToggle,
  Skeleton,
} from '../../components/primitives';

/**
 * THE SIGNATURE SCREEN.
 *
 * Everything else in this console is a quiet table. This is the one place the design
 * spends its boldness: the four-stage adapter pipeline — validate, normalize, settle,
 * receipt — rendered for both protocols at once, from real run data, so the claim the
 * whole project rests on becomes visible rather than asserted. Two protocols, one cart,
 * one merchant, the same settlement shape underneath.
 */

interface TraceEntry {
  step: string;
  at: string;
  detail: Record<string, unknown>;
}

interface Trace {
  file: string;
  summary: {
    protocol?: string;
    picker?: string;
    outcome?: string;
    paymentRequestId?: string | null;
    startedAt?: string;
  };
  entries: TraceEntry[];
}

type StageState = 'reached' | 'declined' | 'not-reached';

interface Stage {
  id: string;
  label: string;
  caption: string;
  state: StageState;
  note: string | null;
  payload: unknown;
}

/**
 * Maps a run trace onto the §2.2 adapter contract.
 *
 * The two protocols reach the same four stages by different routes — x402 through a
 * challenge and a proof, AP2 through a signed mandate — which is exactly the point being
 * demonstrated, so the mapping is explicit per protocol rather than smoothed over.
 */
function toStages(trace: Trace): Stage[] {
  const find = (needle: string): TraceEntry | undefined =>
    trace.entries.find((entry) => entry.step.includes(needle));

  const isX402 = trace.summary.protocol === 'x402';

  /**
   * A stage counts as REACHED only if its call actually succeeded. An earlier version
   * inferred this from the trace entry merely existing, which meant a declined mandate
   * displayed all four stages as reached — the screen claimed a rejected request had
   * settled. The HTTP status in the recorded response is the authority.
   */
  const outcomeOf = (
    entry: TraceEntry | undefined,
    /**
     * Statuses that mean SUCCESS for this particular stage. x402's challenge step is the
     * case that matters: HTTP 402 is the protocol working exactly as designed — it is
     * the status the protocol is named after — so a blanket `status >= 400` rule marked
     * a healthy x402 run as declined.
     */
    expected: readonly number[] = [],
  ): { state: StageState; note: string | null } => {
    if (entry === undefined) return { state: 'not-reached', note: null };

    const response = entry.detail['response'];
    if (typeof response !== 'object' || response === null) {
      return { state: 'reached', note: null };
    }

    const status = (response as { status?: unknown }).status;
    if (typeof status !== 'number') return { state: 'reached', note: null };
    if (expected.includes(status)) return { state: 'reached', note: null };
    if (status < 400) return { state: 'reached', note: null };

    const body = (response as { body?: unknown }).body;
    const error =
      typeof body === 'object' && body !== null && 'error' in body
        ? String((body as { error: unknown }).error).replace(/_/g, ' ')
        : `HTTP ${status}`;
    return { state: 'declined', note: error };
  };

  const validate = isX402 ? find('x402.challenge') : find('ap2.mandate_signed');
  const normalize = isX402 ? find('x402.envelope_parsed') : find('picker.decision');
  const settleEntry = isX402 ? find('x402.redeem') : find('ap2.submit');
  const settle = outcomeOf(settleEntry);

  return [
    {
      id: 'validate',
      label: 'Validate',
      caption: isX402
        ? 'Gateway issues a 402 with a one-time payment envelope'
        : 'Agent signs the mandate; gateway verifies the Ed25519 signature',
      // 402 is the success case for the x402 challenge.
      ...outcomeOf(validate, isX402 ? [402] : []),
      payload: validate?.detail ?? null,
    },
    {
      id: 'normalize',
      label: 'Normalize',
      caption: 'Protocol-specific request becomes one internal shape',
      ...outcomeOf(normalize),
      payload: normalize?.detail ?? null,
    },
    {
      id: 'settle',
      label: 'Settle',
      caption:
        settle.state === 'declined'
          ? 'Guardrails refused this request — no Razorpay order was created'
          : 'Guardrails pass, a real Razorpay order is created',
      state: settle.state,
      note: settle.note,
      payload: settleEntry?.detail ?? null,
    },
    {
      id: 'receipt',
      label: 'Receipt',
      caption:
        settle.state === 'declined'
          ? 'Not issued — the request never settled'
          : 'Outcome returned in the protocol’s own shape',
      // A receipt cannot exist for a request that was refused.
      state: settle.state === 'declined' ? 'not-reached' : settle.state,
      note: null,
      payload: settle.state === 'declined' ? null : (settleEntry?.detail ?? null),
    },
  ];
}

function PipelineColumn({ trace }: { trace: Trace }) {
  const stages = toStages(trace);
  const protocol = trace.summary.protocol ?? 'unknown';

  return (
    <div className="min-w-0 flex-1">
      <div className="mb-3 flex items-center gap-2">
        <ProtocolTag protocol={protocol} />
        <span className="t-small font-medium">{protocol === 'x402' ? 'x402' : 'AP2'}</span>
        <span className="t-micro" style={{ color: 'var(--color-ink-faint)' }}>
          {trace.summary.picker}
        </span>
      </div>

      <ol className="space-y-2">
        {stages.map((stage, index) => (
          <li key={stage.id}>
            <div
              className="border p-3"
              style={{
                background:
                  stage.state === 'not-reached' ? 'var(--color-sunken)' : 'var(--color-raised)',
                borderColor:
                  stage.state === 'declined'
                    ? 'var(--color-danger)'
                    : stage.state === 'reached'
                      ? 'var(--color-accent-edge)'
                      : 'var(--color-edge)',
                borderRadius: 'var(--radius-md)',
                opacity: stage.state === 'not-reached' ? 0.45 : 1,
              }}
            >
              <div className="flex items-baseline gap-2">
                <span
                  className="t-micro tnum"
                  style={{
                    color:
                      stage.state === 'declined'
                        ? 'var(--color-danger)'
                        : stage.state === 'reached'
                          ? 'var(--color-accent)'
                          : 'var(--color-ink-faint)',
                  }}
                >
                  {String(index + 1).padStart(2, '0')}
                </span>
                <span className="t-small font-semibold">{stage.label}</span>
                {stage.state === 'reached' && (
                  <span className="t-micro ml-auto" style={{ color: 'var(--color-ok)' }}>
                    ✓ reached
                  </span>
                )}
                {stage.state === 'declined' && (
                  <span className="t-micro ml-auto" style={{ color: 'var(--color-danger)' }}>
                    ✕ declined
                  </span>
                )}
              </div>
              <p className="t-small mt-1" style={{ color: 'var(--color-ink-muted)' }}>
                {stage.caption}
              </p>
              {stage.note !== null && (
                <p className="t-small mt-1" style={{ color: 'var(--color-danger)' }}>
                  {stage.note}
                </p>
              )}
              {stage.payload !== null && <RawToggle label="Payload" data={stage.payload} />}
            </div>
            {index < stages.length - 1 && (
              <div
                aria-hidden
                className="mx-auto h-3 w-px"
                style={{ background: 'var(--color-edge-strong)' }}
              />
            )}
          </li>
        ))}
      </ol>

      <p className="t-small mt-3" style={{ color: 'var(--color-ink-muted)' }}>
        Outcome <span className="tnum">{trace.summary.outcome ?? 'unknown'}</span>
        {trace.summary.paymentRequestId !== null &&
          trace.summary.paymentRequestId !== undefined && (
            <>
              {' · '}
              <Mono value={trace.summary.paymentRequestId} chars={12} />
            </>
          )}
      </p>
    </div>
  );
}

type Phase = 'loading' | 'ready' | 'failed';

export default function ProtocolTesterPage() {
  const [phase, setPhase] = useState<Phase>('loading');
  const [traces, setTraces] = useState<Trace[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [liveLog, setLiveLog] = useState<string[]>([]);
  const [running, setRunning] = useState(false);

  /**
   * Reads the recorded runs.
   *
   * Previously this had no try/catch at all: if /api/traces failed or returned something
   * that was not JSON, the promise rejected unhandled and the screen sat on "No runs
   * recorded yet" forever — telling the operator there was no data when the truth was
   * that it had not managed to look.
   */
  const load = useCallback(async (retry = false) => {
    if (retry) {
      setPhase('loading');
      setLoadError(null);
    }
    try {
      const response = await fetch('/api/traces', { cache: 'no-store' });
      if (!response.ok) throw new Error(`The trace reader answered ${response.status}.`);
      const body = (await response.json()) as { traces?: Trace[] };
      setTraces(body.traces ?? []);
      setPhase('ready');
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : 'Could not read the recorded runs.');
      setPhase('failed');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const latest = (protocol: string): Trace | undefined =>
    traces.find((trace) => trace.summary.protocol === protocol);

  const x402 = latest('x402');
  const ap2 = latest('ap2');

  /**
   * Live x402 run, driven from the browser.
   *
   * Only x402 can be driven from here. AP2 requires signing an IntentMandate with the
   * agent's Ed25519 private key, and that key must never reach a browser — that is the
   * §3.1 guarantee the whole trust model rests on. AP2 stays replay-only, deliberately.
   */
  const runLiveX402 = async () => {
    setRunning(true);
    setLiveLog([]);
    const log = (line: string) => setLiveLog((current) => [...current, line]);

    try {
      const policy = await getPolicy();
      const agents = await listAgents();
      const agent = agents.agents.find(
        (candidate) => candidate.protocol === 'x402' && candidate.revoked_at === null,
      );

      if (agent === undefined) {
        log('No active x402 agent registered. Run the reference agent setup first.');
        return;
      }

      log(`Using agent ${agent.external_agent_id}`);

      const challengeUrl =
        `${GATEWAY_URL}/v1/x402/checkout/cart_demo_001` +
        `?agentId=${encodeURIComponent(agent.external_agent_id)}` +
        `&merchantId=${encodeURIComponent(policy.merchant_id)}&amountPaise=25000`;

      const challenge = await fetch(challengeUrl);
      log(
        `GET checkout → ${challenge.status} ${challenge.status === 402 ? 'Payment Required' : ''}`,
      );

      const envelopeHeader = challenge.headers.get('payment-required');
      if (envelopeHeader === null) {
        log('No PAYMENT-REQUIRED header returned — cannot continue.');
        return;
      }

      const envelope = JSON.parse(envelopeHeader) as { reference: string; amount: number };
      log(`Envelope reference ${envelope.reference.slice(0, 18)}…`);

      const redeem = await fetch(`${GATEWAY_URL}/v1/x402/checkout/cart_demo_001`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'payment-signature': JSON.stringify({
            reference: envelope.reference,
            amount: envelope.amount,
            razorpayPaymentId: 'dashboard_live_proof',
          }),
        },
        body: '{}',
      });

      const result = (await redeem.json()) as Record<string, unknown>;
      log(`POST proof → ${redeem.status}`);
      log(
        redeem.status === 200
          ? `Settled to payment_request ${String(result['payment_request_id']).slice(0, 12)}… (awaiting webhook)`
          : `Declined: ${String(result['error'] ?? 'unknown')}`,
      );
    } catch (cause) {
      log(`Failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setRunning(false);
      void load();
    }
  };

  return (
    <div>
      <PageHeader
        title="Protocol tester"
        description="The same purchase, arriving two different ways, ending in the same settlement. Stages come from the reference agent's real runs against this gateway."
        actions={
          <Button variant="accent" onClick={() => void runLiveX402()} disabled={running}>
            {running ? 'Running…' : 'Run live x402'}
          </Button>
        }
      />

      {liveLog.length > 0 && (
        /* The run reports progress line by line; polite so it is read after whatever the
           user is currently on rather than interrupting them mid-sentence. */
        <Card className="mt-5 p-4" role="log" ariaLive="polite" ariaLabel="Live run progress">
          <p className="t-micro" style={{ color: 'var(--color-accent)' }}>
            Live run
          </p>
          <ol className="mt-2 space-y-1">
            {liveLog.map((line, index) => (
              <li key={index} className="tnum t-small" style={{ color: 'var(--color-ink-muted)' }}>
                {line}
              </li>
            ))}
          </ol>
        </Card>
      )}

      {phase === 'loading' ? (
        <div className="mt-6 flex flex-col gap-6 lg:flex-row" aria-busy="true">
          <span className="sr-only">Loading recorded runs…</span>
          {[0, 1].map((column) => (
            <div key={column} className="min-w-0 flex-1">
              <div className="mb-3">
                <Skeleton width="30%" height={14} />
              </div>
              <div className="space-y-2">
                {[0, 1, 2, 3].map((stage) => (
                  <div
                    key={stage}
                    className="border p-3"
                    style={{
                      borderColor: 'var(--color-edge)',
                      borderRadius: 'var(--radius-md)',
                    }}
                  >
                    <Skeleton width="40%" height={13} />
                    <div className="mt-2">
                      <Skeleton width="75%" />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : phase === 'failed' ? (
        <Card className="mt-6">
          <ErrorState
            title="Could not read the recorded runs"
            detail={`${loadError ?? 'The trace reader did not answer.'} Traces are read from packages/agent-client/traces.`}
            onRetry={() => void load(true)}
          />
        </Card>
      ) : traces.length === 0 ? (
        <Card className="mt-6 p-8 text-center">
          <p className="t-body font-medium">No runs recorded yet</p>
          <p className="t-small mt-1" style={{ color: 'var(--color-ink-muted)' }}>
            Run the reference agent over either protocol, or use “Run live x402” above.
          </p>
        </Card>
      ) : (
        <div className="mt-6 flex flex-col gap-6 lg:flex-row">
          {x402 !== undefined ? <PipelineColumn trace={x402} /> : <div className="flex-1" />}
          <div
            aria-hidden
            className="hidden w-px lg:block"
            style={{ background: 'var(--color-edge)' }}
          />
          {ap2 !== undefined ? <PipelineColumn trace={ap2} /> : <div className="flex-1" />}
        </div>
      )}

      <p className="t-small mt-8 max-w-2xl" style={{ color: 'var(--color-ink-faint)' }}>
        Live runs are x402 only. Driving AP2 from here would mean handing the agent&rsquo;s private
        signing key to a browser, and that key is exactly what proves a mandate is genuine — so AP2
        is replayed from recorded runs instead.
      </p>
    </div>
  );
}
