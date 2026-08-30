/**
 * Run trace recorder (Phase 4 deliverable).
 *
 * "Full request/response trace logged to a JSON file — this becomes the raw material
 * for the protocol-tester panel in Phase 5 and for the demo video."
 *
 * Records every HTTP call, every signature, every gateway response, and the LLM's raw
 * tool-call payloads. Deliberately verbatim: a trace that paraphrases what the model
 * emitted is useless as evidence.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export interface TraceEntry {
  readonly step: string;
  readonly at: string;
  readonly detail: Readonly<Record<string, unknown>>;
}

export interface TraceSummary {
  readonly protocol: string;
  readonly picker: string;
  readonly cartId: string;
  readonly merchantId: string;
  readonly agentId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly outcome: string;
  readonly paymentRequestId: string | null;
  readonly razorpayOrderId: string | null;
}

export class RunTrace {
  private readonly entries: TraceEntry[] = [];
  private readonly startedAt = new Date().toISOString();

  record(step: string, detail: Record<string, unknown>): void {
    this.entries.push({ step, at: new Date().toISOString(), detail });
  }

  /** Records an HTTP exchange in full — request AND response, headers included. */
  recordHttp(
    step: string,
    request: { method: string; url: string; headers?: Record<string, string>; body?: unknown },
    response: { status: number; body: unknown },
  ): void {
    this.record(step, { request, response });
  }

  get length(): number {
    return this.entries.length;
  }

  all(): readonly TraceEntry[] {
    return this.entries;
  }

  write(path: string, summary: Omit<TraceSummary, 'startedAt' | 'finishedAt'>): string {
    const absolute = resolve(path);
    mkdirSync(dirname(absolute), { recursive: true });

    const payload = {
      summary: {
        ...summary,
        startedAt: this.startedAt,
        finishedAt: new Date().toISOString(),
      } satisfies TraceSummary,
      entries: this.entries,
    };

    writeFileSync(absolute, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    return absolute;
  }
}
