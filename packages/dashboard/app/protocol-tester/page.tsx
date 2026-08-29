import { PhasePlaceholder } from '@/components/PhasePlaceholder';

export default function ProtocolTesterPage() {
  return (
    <PhasePlaceholder
      title="Protocol Tester"
      phase="Phase 5"
      spec="WHITEPAPER.md §2.2 (ProtocolAdapter) and §2.4"
      bullets={[
        'Paste or trigger a raw x402 / AP2 request straight from the browser.',
        'Renders the adapter’s validate → normalize → settle → receipt steps side by side, live.',
        'Consumes the request/response traces produced by the Phase 4 reference agent.',
        'The single most demo-able screen in the project, per the whitepaper.',
      ]}
    />
  );
}
