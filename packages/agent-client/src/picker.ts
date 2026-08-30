/**
 * The provider-agnostic reasoning-layer seam (Phase 4).
 *
 * `CartPicker` is the interface referenced by WHITEPAPER.md §4 Phase 4 as
 * "agent-client's picker interface". Two implementations sit behind it:
 *
 *   - LlmToolAgent        (llm-tool-agent.ts)     — NVIDIA Nemotron 3 Ultra via
 *                                                   OpenRouter's OpenAI-compatible API,
 *                                                   using real tool-calling. Default.
 *   - DeterministicPicker (deterministic-picker.ts) — no network, no model. Fallback for
 *                                                   test mode, offline runs, and free-tier
 *                                                   rate limits.
 *
 * This is the whole point of the architecture note in the whitepaper: what the agent
 * DECIDES is behind this seam; what the agent DOES with that decision — mandates,
 * signatures, nonces, settlement — is not. Swapping to the Anthropic API means adding a
 * third implementation of this interface and nothing else.
 */

/** One purchasable item from the fixture catalogue. */
export interface CartItem {
  readonly sku: string;
  readonly name: string;
  readonly amountPaise: number;
  readonly category: string;
}

/** What the picker was asked to do. */
export interface PickRequest {
  readonly cartId: string;
  readonly items: readonly CartItem[];
  /** Hard ceiling. A picker returning anything above this is rejected by the caller. */
  readonly maxAmountPaise: number;
}

/** What the picker decided, plus how it got there. */
export interface PickResult {
  readonly sku: string;
  readonly amountPaise: number;
  /** Human-readable justification, surfaced in the trace and the demo video. */
  readonly reasoning: string;
  /** Which implementation produced this — 'llm:<model>' or 'deterministic'. */
  readonly pickedBy: string;
  /**
   * Raw tool-call payloads exactly as the model emitted them, unparaphrased.
   * Empty for the deterministic picker. Written verbatim into the run trace.
   */
  readonly toolCalls: readonly unknown[];
}

export interface CartPicker {
  /** Stable identifier for the trace, e.g. 'llm-tool-agent' or 'deterministic-picker'. */
  readonly name: string;

  /**
   * Chooses one item to buy. Implementations must not exceed request.maxAmountPaise —
   * but the caller re-checks anyway, because a reasoning layer is untrusted input just
   * like an agent request is.
   */
  pick(request: PickRequest): Promise<PickResult>;
}

/** Thrown when a picker cannot produce a usable decision. */
export class PickerError extends Error {
  readonly picker: string;
  /** True when the failure is a rate limit, which the CLI handles by falling back. */
  readonly rateLimited: boolean;

  constructor(picker: string, message: string, rateLimited = false) {
    super(message);
    this.name = 'PickerError';
    this.picker = picker;
    this.rateLimited = rateLimited;
  }
}
