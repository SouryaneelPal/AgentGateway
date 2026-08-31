/**
 * Serves the reference agent's real run traces to the protocol tester.
 *
 * These are the actual JSON files written by Phase 4's live runs against the gateway —
 * not fixtures invented for the UI. Reading them server-side keeps the browser out of
 * the filesystem and means a new run appears in the tester without a rebuild.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const TRACE_DIR = join(process.cwd(), '..', 'agent-client', 'traces');

interface TraceSummary {
  protocol?: string;
  picker?: string;
  outcome?: string;
  paymentRequestId?: string | null;
  startedAt?: string;
}

export async function GET(): Promise<NextResponse> {
  let files: string[];
  try {
    files = (await readdir(TRACE_DIR)).filter((name) => name.endsWith('.json'));
  } catch {
    return NextResponse.json({ traces: [], note: 'No traces directory yet.' });
  }

  const traces = [];
  for (const name of files.slice(-40)) {
    try {
      const raw = await readFile(join(TRACE_DIR, name), 'utf8');
      const parsed = JSON.parse(raw) as { summary?: TraceSummary; entries?: unknown[] };
      traces.push({
        file: name,
        summary: parsed.summary ?? {},
        entries: parsed.entries ?? [],
      });
    } catch {
      // A half-written trace from a run in flight — skip rather than fail the page.
    }
  }

  traces.sort((a, b) =>
    String(b.summary.startedAt ?? '').localeCompare(String(a.summary.startedAt ?? '')),
  );

  return NextResponse.json({ traces });
}
