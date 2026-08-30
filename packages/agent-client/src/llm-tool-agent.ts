/**
 * LLM reasoning layer (Phase 4) — IMPLEMENTED.
 *
 * NVIDIA Nemotron 3 Ultra (550B-A55B MoE) via OpenRouter's OpenAI-compatible endpoint,
 * driven with real tool-calling. Implements CartPicker, so it is interchangeable with
 * DeterministicPicker at the call site.
 *
 * RENAMED from claude-tool-agent.ts. The file no longer talks to Claude, and a filename
 * naming one vendor would contradict the very design claim the whitepaper makes about
 * this layer being provider-agnostic. Switching to Anthropic later means a third
 * implementation of CartPicker, not renaming this one back.
 *
 * BOUNDED BY CONSTRUCTION — this thing decides how money gets spent:
 *   - a hard step limit on the tool-calling loop (no unbounded agent loop)
 *   - maxAmountPaise is enforced in the tool handler AND re-checked by the caller
 *   - only two tools exist, neither of which can move money; initiate_purchase records
 *     an intent that the protocol clients then execute under the gateway's guardrails
 * The model chooses WHAT to buy. It cannot choose to exceed the ceiling, and it has no
 * path to settlement that bypasses the gateway.
 *
 * NOTE ON THIS MODEL: Nemotron is a reasoning model — it emits a `reasoning` block
 * before its answer, and a small max_tokens budget gets consumed by that reasoning
 * before any tool call appears (observed: finish_reason 'length' at 32 tokens). Hence
 * the generous MAX_TOKENS below.
 */

import OpenAI from 'openai';
import type { CartPicker, CartItem, PickRequest, PickResult } from './picker.js';
import { PickerError } from './picker.js';

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
export const NEMOTRON_MODEL = 'nvidia/nemotron-3-ultra-550b-a55b:free';

/** Hard cap on tool-calling turns. Reached => give up, do not loop. */
const MAX_STEPS = 6;
/** Reasoning models need headroom before they emit a tool call. */
const MAX_TOKENS = 2048;

interface PurchaseIntent {
  sku: string;
  amountPaise: number;
}

const TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'search_cart_options',
      description:
        'List the purchasable items in a cart, with their price in paise and category. Call this first.',
      parameters: {
        type: 'object',
        properties: { cartId: { type: 'string', description: 'The cart to inspect.' } },
        required: ['cartId'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'initiate_purchase',
      description:
        'Commit to purchasing exactly one item. Call this once you have decided. The purchase is then executed over the configured payment protocol.',
      parameters: {
        type: 'object',
        properties: {
          sku: { type: 'string', description: 'SKU of the item to buy.' },
          amountPaise: { type: 'integer', description: 'Price in paise. Must match the SKU.' },
          reasoning: { type: 'string', description: 'One sentence: why this item.' },
        },
        required: ['sku', 'amountPaise'],
        additionalProperties: false,
      },
    },
  },
];

function systemPrompt(maxAmountPaise: number): string {
  return [
    'You are an autonomous buyer agent operating under a strict spending mandate.',
    `Your spending ceiling for this task is ${maxAmountPaise} paise. You MUST NOT choose an item priced above it.`,
    'Workflow: call search_cart_options first to see what is available, then call initiate_purchase exactly once for the single item you choose.',
    'Prefer the best value within the ceiling. Do not ask the user questions — decide and act.',
  ].join('\n');
}

export class LlmToolAgent implements CartPicker {
  readonly name = 'llm-tool-agent';
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(options: { apiKey: string; model?: string; baseURL?: string }) {
    this.model = options.model ?? NEMOTRON_MODEL;
    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseURL ?? OPENROUTER_BASE_URL,
      defaultHeaders: {
        // OpenRouter attribution headers — optional, but they identify the caller.
        'HTTP-Referer': 'https://github.com/SouryaneelPal/AgentGateway',
        'X-Title': 'AgentGateway Reference Agent',
      },
    });
  }

  async pick(request: PickRequest): Promise<PickResult> {
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt(request.maxAmountPaise) },
      {
        role: 'user',
        content: `Buy one item from cart ${request.cartId}, staying at or under ${request.maxAmountPaise} paise.`,
      },
    ];

    const rawToolCalls: unknown[] = [];
    let intent: PurchaseIntent | null = null;
    let reasoning = '';

    for (let step = 0; step < MAX_STEPS; step += 1) {
      const completion = await this.complete(messages);

      // OpenRouter can return an error-shaped body with HTTP 200 (upstream provider
      // hiccup, free-tier throttling), in which case `choices` is absent entirely.
      // Indexing it blindly throws "Cannot read properties of undefined (reading '0')",
      // which is what a live AP2 run actually hit — an unhelpful crash in place of a
      // handleable condition. Check the ARRAY, not just the element.
      if (!Array.isArray(completion.choices) || completion.choices.length === 0) {
        const upstream = (
          completion as unknown as { error?: { message?: unknown; code?: unknown } }
        ).error;
        const detail =
          upstream === undefined
            ? 'response carried no choices'
            : `upstream error: ${String(upstream.message ?? 'unknown')} (code ${String(upstream.code ?? '?')})`;
        // Treat it as retryable-by-fallback: the CLI drops to the deterministic picker
        // rather than failing the run, same as a 429.
        throw new PickerError(this.name, detail, true);
      }

      const choice = completion.choices[0];

      if (choice === undefined) {
        throw new PickerError(this.name, 'model returned no choices', true);
      }

      const message = choice.message;
      messages.push(message);

      const toolCalls = message.tool_calls ?? [];
      if (toolCalls.length === 0) {
        // No tool call and no decision yet — nudge once rather than looping silently.
        if (intent !== null) break;
        messages.push({
          role: 'user',
          content: 'You must call initiate_purchase with your chosen SKU now.',
        });
        continue;
      }

      for (const call of toolCalls) {
        // Recorded VERBATIM — the trace must show what the model actually emitted.
        rawToolCalls.push(JSON.parse(JSON.stringify(call)) as unknown);

        if (call.type !== 'function') continue;
        const { name, args } = readCall(call);

        if (name === 'search_cart_options') {
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify({
              cartId: request.cartId,
              maxAmountPaise: request.maxAmountPaise,
              items: request.items,
            }),
          });
          continue;
        }

        if (name === 'initiate_purchase') {
          const result = this.handlePurchase(args, request);
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify(result.toolResponse),
          });
          if (result.intent !== null) {
            intent = result.intent;
            reasoning = result.reasoning;
          }
          continue;
        }

        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify({ error: `unknown tool ${name}` }),
        });
      }

      if (intent !== null) break;
    }

    if (intent === null) {
      throw new PickerError(
        this.name,
        `model did not call initiate_purchase within ${MAX_STEPS} steps`,
      );
    }

    return {
      sku: intent.sku,
      amountPaise: intent.amountPaise,
      reasoning: reasoning.length > 0 ? reasoning : 'no reasoning supplied by the model',
      pickedBy: `llm:${this.model}`,
      toolCalls: rawToolCalls,
    };
  }

  /** Validates the model's choice against the catalogue and the ceiling. */
  private handlePurchase(
    args: Record<string, unknown>,
    request: PickRequest,
  ): { intent: PurchaseIntent | null; reasoning: string; toolResponse: Record<string, unknown> } {
    const sku = typeof args['sku'] === 'string' ? args['sku'] : null;
    const reasoning = typeof args['reasoning'] === 'string' ? args['reasoning'] : '';

    if (sku === null) {
      return { intent: null, reasoning, toolResponse: { error: 'sku is required' } };
    }

    const item: CartItem | undefined = request.items.find((candidate) => candidate.sku === sku);
    if (item === undefined) {
      return {
        intent: null,
        reasoning,
        toolResponse: { error: `unknown sku ${sku}`, validSkus: request.items.map((i) => i.sku) },
      };
    }

    // The ceiling is enforced HERE, not trusted from the model's arguments. A model that
    // asks to overspend is told no and given the chance to pick again.
    if (item.amountPaise > request.maxAmountPaise) {
      return {
        intent: null,
        reasoning,
        toolResponse: {
          error: 'exceeds_spending_ceiling',
          sku,
          amountPaise: item.amountPaise,
          maxAmountPaise: request.maxAmountPaise,
        },
      };
    }

    return {
      // Price comes from the catalogue, never from the model's own amountPaise argument.
      intent: { sku: item.sku, amountPaise: item.amountPaise },
      reasoning,
      toolResponse: { accepted: true, sku: item.sku, amountPaise: item.amountPaise },
    };
  }

  private async complete(
    messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  ): Promise<OpenAI.Chat.Completions.ChatCompletion> {
    try {
      return await this.client.chat.completions.create({
        model: this.model,
        messages,
        tools: TOOLS,
        max_tokens: MAX_TOKENS,
      });
    } catch (error) {
      // Free-tier rate limits are expected and are the CLI's cue to fall back to the
      // deterministic picker rather than failing the run.
      const status = (error as { status?: number }).status;
      const message = error instanceof Error ? error.message : String(error);
      throw new PickerError(this.name, `OpenRouter call failed: ${message}`, status === 429);
    }
  }
}

function readCall(call: OpenAI.Chat.Completions.ChatCompletionMessageToolCall): {
  name: string;
  args: Record<string, unknown>;
} {
  const fn = (call as { function?: { name?: unknown; arguments?: unknown } }).function;
  const name = typeof fn?.name === 'string' ? fn.name : '';
  let args: Record<string, unknown> = {};

  if (typeof fn?.arguments === 'string') {
    try {
      const parsed: unknown = JSON.parse(fn.arguments);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        args = parsed as Record<string, unknown>;
      }
    } catch {
      args = {};
    }
  }

  return { name, args };
}
