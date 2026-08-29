import { PhasePlaceholder } from '@/components/PhasePlaceholder';

export default function PolicyPage() {
  return (
    <PhasePlaceholder
      title="Policy Console"
      phase="Phase 5"
      spec="WHITEPAPER.md §2.4 (GET/PUT /v1/merchant/policy)"
      bullets={[
        'Edit spend caps, blocked categories and enabled protocols per merchant.',
        'Writes to PUT /v1/merchant/policy; reads current guardrails from GET /v1/merchant/policy.',
        'Backed by merchants.policy (JSONB) and merchants.enabled_protocols in §2.3.',
      ]}
    />
  );
}
