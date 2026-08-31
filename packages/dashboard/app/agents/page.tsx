'use client';

import { useCallback, useEffect, useState } from 'react';
import { listAgents, revokeAgent, type AgentIdentity } from '../../lib/api-client';
import {
  Button,
  Card,
  EmptyState,
  Money,
  Mono,
  PageHeader,
  ProtocolTag,
} from '../../components/primitives';

export default function AgentsPage() {
  const [agents, setAgents] = useState<AgentIdentity[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const result = await listAgents();
      setAgents(result.agents);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load agents.');
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const revoke = async (agent: AgentIdentity) => {
    setBusy(agent.agent_identity_id);
    setNotice(null);
    try {
      await revokeAgent(agent.agent_identity_id);
      setNotice(
        `${agent.external_agent_id} is revoked. Its very next request will be refused — nothing further can be spent on your behalf.`,
      );
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not revoke that agent.');
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

      {error !== null && (
        <p className="t-small mt-4" style={{ color: 'var(--color-danger)' }}>
          {error}
        </p>
      )}
      {notice !== null && (
        <p
          className="t-small mt-4 border px-3 py-2"
          style={{
            color: 'var(--color-ok)',
            background: 'var(--color-ok-ground)',
            borderColor: 'var(--color-ok)',
            borderRadius: 'var(--radius-md)',
          }}
        >
          {notice}
        </p>
      )}

      <Card className="mt-6 overflow-hidden">
        {agents.length === 0 ? (
          <EmptyState
            title="No agents registered"
            hint="Run the reference agent's setup command to onboard one."
          />
        ) : (
          <table className="w-full border-collapse">
            <thead>
              <tr
                className="border-b text-left"
                style={{ borderColor: 'var(--color-edge)', background: 'var(--color-sunken)' }}
              >
                {['Agent', 'Protocol', 'Trust', 'Spent / limit', 'Key', 'State', ''].map((h) => (
                  <th
                    key={h}
                    className="t-micro px-4 py-2.5 font-semibold"
                    style={{ color: 'var(--color-ink-faint)' }}
                  >
                    {h}
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
        )}
      </Card>
    </div>
  );
}
