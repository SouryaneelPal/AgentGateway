'use client';

import { useCallback, useEffect, useState } from 'react';
import { describeFailure, listAgents, revokeAgent, type AgentIdentity } from '../../lib/api-client';
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  InlineError,
  InlineNotice,
  Money,
  Mono,
  PageHeader,
  ProtocolTag,
  TableSkeleton,
} from '../../components/primitives';

const COLUMNS = ['Agent', 'Protocol', 'Trust', 'Spent / limit', 'Key', 'State', ''];

type Phase = 'loading' | 'ready' | 'failed';

export default function AgentsPage() {
  const [phase, setPhase] = useState<Phase>('loading');
  const [agents, setAgents] = useState<AgentIdentity[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (retry = false) => {
    if (retry) setPhase('loading');
    try {
      const result = await listAgents();
      setAgents(result.agents);
      setError(null);
      setPhase('ready');
    } catch (cause) {
      setError(describeFailure(cause, 'Could not load agents.'));
      setPhase((current) => (current === 'ready' ? 'ready' : 'failed'));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const revoke = async (agent: AgentIdentity) => {
    setBusy(agent.agent_identity_id);
    setNotice(null);
    setError(null);
    try {
      await revokeAgent(agent.agent_identity_id);
      setNotice(
        `${agent.external_agent_id} is revoked. Its very next request will be refused — nothing further can be spent on your behalf.`,
      );
      await refresh();
    } catch (cause) {
      setError(describeFailure(cause, 'Could not revoke that agent.'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <PageHeader
        title="Agents"
        description="Software identities allowed to spend on your behalf. Revoking one takes effect immediately — its next request is refused before any money moves."
      />

      {phase === 'ready' && error !== null && <InlineError message={error} />}
      {notice !== null && <InlineNotice message={notice} />}

      <Card className="mt-6 overflow-hidden">
        {phase === 'loading' ? (
          <TableSkeleton columns={COLUMNS} rows={4} />
        ) : phase === 'failed' ? (
          <ErrorState
            title="Could not load agents"
            detail={error ?? 'The gateway did not answer.'}
            onRetry={() => void refresh(true)}
          />
        ) : agents.length === 0 ? (
          <EmptyState
            title="No agents registered"
            hint="Run the reference agent's setup command to onboard one."
          />
        ) : (
          <div className="relative overflow-x-auto">
            <table className="w-full border-collapse" style={{ minWidth: '52rem' }}>
              <caption className="sr-only">
                Registered agent identities, their spending limits and revocation state.
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
                      {heading === '' ? <span className="sr-only">Actions</span> : heading}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {agents.map((agent) => {
                  const revoked = agent.revoked_at !== null;
                  return (
                    <tr
                      key={agent.agent_identity_id}
                      className="border-b"
                      style={{ borderColor: 'var(--color-edge)', opacity: revoked ? 0.55 : 1 }}
                    >
                      <td className="px-4 py-3">
                        <Mono value={agent.external_agent_id} chars={22} />
                      </td>
                      <td className="px-4 py-3">
                        <ProtocolTag protocol={agent.protocol} />
                      </td>
                      <td className="t-small px-4 py-3" style={{ color: 'var(--color-ink-muted)' }}>
                        {agent.trust_level}
                      </td>
                      <td className="t-small px-4 py-3">
                        <Money paise={agent.spent_paise} />
                        <span style={{ color: 'var(--color-ink-faint)' }}> / </span>
                        <Money paise={agent.spending_limit_paise} />
                      </td>
                      <td className="t-small px-4 py-3" style={{ color: 'var(--color-ink-muted)' }}>
                        {agent.has_public_key ? 'Registered' : '—'}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className="t-micro inline-flex items-center gap-1.5 px-1.5 py-0.5"
                          style={{
                            color: revoked ? 'var(--color-danger)' : 'var(--color-ok)',
                            background: revoked
                              ? 'var(--color-danger-ground)'
                              : 'var(--color-ok-ground)',
                            borderRadius: 'var(--radius-sm)',
                          }}
                        >
                          <span aria-hidden>{revoked ? '✕' : '●'}</span>
                          {revoked ? 'Revoked' : 'Active'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        {!revoked && (
                          <Button
                            variant="danger"
                            disabled={busy === agent.agent_identity_id}
                            onClick={() => void revoke(agent)}
                            /* "Revoke" alone repeats down the column with nothing to
                               distinguish the rows by ear. */
                            ariaLabel={`Revoke agent ${agent.external_agent_id}`}
                          >
                            {busy === agent.agent_identity_id ? 'Revoking…' : 'Revoke'}
                          </Button>
                        )}
                      </td>
                    </tr>
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
