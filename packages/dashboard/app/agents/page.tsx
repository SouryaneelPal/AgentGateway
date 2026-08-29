import { PhasePlaceholder } from '@/components/PhasePlaceholder';

export default function AgentsPage() {
  return (
    <PhasePlaceholder
      title="Agent Management"
      phase="Phase 5"
      spec="WHITEPAPER.md §2.4 (POST /v1/merchant/agents/:id/revoke)"
      bullets={[
        'Lists registered agent identities with protocol, trust level and remaining spend.',
        'One-click revoke sets agent_identities.revoked_at, checked on every later request.',
        'Phase 5 validation: revoking mid-session must block the agent’s very next request.',
      ]}
    />
  );
}
