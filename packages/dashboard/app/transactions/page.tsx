import { PhasePlaceholder } from '@/components/PhasePlaceholder';

export default function TransactionsPage() {
  return (
    <PhasePlaceholder
      title="Transactions & Audit Feed"
      phase="Phase 5"
      spec="WHITEPAPER.md §2.4 (/v1/merchant/transactions, /v1/merchant/audit-log, /v1/merchant/stream)"
      bullets={[
        'Unified cross-protocol transaction log, filterable by status and protocol.',
        'Live updates over SSE from GET /v1/merchant/stream.',
        'Each row links into the full decision trail for that request, from audit_log.',
        'Must stay readable by a non-technical viewer — that is the Phase 5 validation bar.',
      ]}
    />
  );
}
