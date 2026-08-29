/**
 * Claude reasoning layer for the simulated buyer agent (Phase 4) — scaffolded in Phase 1.
 *
 * Per the Phase 4 stack note: a Node/TypeScript CLI using the Anthropic API with
 * tool-calling, where Claude decides *what* to buy and the protocol clients handle
 * *how* to pay. Keeping the reasoning and the protocol mechanics in separate modules is
 * what makes the two protocol runs comparable — only the payment path differs.
 */

import type { X402Client } from './x402-client.js';
import type { Ap2Client } from './ap2-client.js';

export class NotImplementedError extends Error {
  constructor(subject: string) {
    super(`${subject} is not implemented yet — scaffolded in Phase 1, lands in Phase 4.`);
    this.name = 'NotImplementedError';
  }
}

/** One entry in the JSON trace that feeds the Phase 5 protocol-tester panel. */
export interface TraceEntry {
  readonly step: string;
  readonly at: string;
  readonly request: Readonly<Record<string, unknown>>;
  readonly response: Readonly<Record<string, unknown>>;
}

export interface ClaudeToolAgentOptions {
  readonly client: X402Client | Ap2Client;
  readonly cartId: string;
  readonly tracePath: string;
}

export class ClaudeToolAgent {
  private readonly options: ClaudeToolAgentOptions;

  constructor(options: ClaudeToolAgentOptions) {
    this.options = options;
  }

  /**
   * TODO(Phase 4): drive an Anthropic tool-calling loop where the tools are
   * `inspect_cart` and `pay_for_cart`, delegate payment to the injected protocol
   * client, and append a TraceEntry per step.
   */
  async run(): Promise<readonly TraceEntry[]> {
    void this.options;
    throw new NotImplementedError('ClaudeToolAgent.run');
  }
}
