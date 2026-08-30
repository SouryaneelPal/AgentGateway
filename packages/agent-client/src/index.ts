#!/usr/bin/env node
/**
 * Reference agent CLI (Phase 4) — IMPLEMENTED.
 *
 * The whole point of this client is the Phase 4 validation bar: both protocol runs,
 * against the identical cart and identical merchant, must terminate in the same
 * razorpay_orders row shape underneath. Same cart, same money, two protocols.
 *
 *   npm run setup   --workspace=agent-client
 *   npm run agent   --workspace=agent-client -- --protocol=x402
 *   npm run agent   --workspace=agent-client -- --protocol=ap2
 *   npm run agent   --workspace=agent-client -- --protocol=ap2 --deterministic
 *   npm run agent   --workspace=agent-client -- --protocol=ap2 --corrupt-signature
 */

import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { Command } from 'commander';
import { DEMO_CART, DEMO_CART_ID, MAX_SPEND_PAISE, findItem } from './catalog.js';
import { DeterministicPicker } from './deterministic-picker.js';
import { LlmToolAgent, NEMOTRON_MODEL } from './llm-tool-agent.js';
import { PickerError, type CartPicker, type PickResult } from './picker.js';
import { RunTrace } from './trace.js';
import { X402Client } from './x402-client.js';
import { Ap2Client } from './ap2-client.js';
import { DEFAULT_KEYSTORE_PATH, loadKeystore, runSetup } from './setup.js';

loadDotenv({ path: resolve(process.cwd(), '.env'), quiet: true });
loadDotenv({ path: resolve(import.meta.dirname, '../../../.env'), quiet: true });

const PROTOCOLS = ['x402', 'ap2'] as const;
type AgentProtocol = (typeof PROTOCOLS)[number];

function parseProtocol(value: string): AgentProtocol {
  const match = PROTOCOLS.find((protocol) => protocol === value);
  if (match === undefined) {
    throw new Error(`--protocol must be one of: ${PROTOCOLS.join(', ')} (received "${value}")`);
  }
  return match;
}

/**
 * Chooses the reasoning layer. Nemotron by default; the deterministic picker on
 * --deterministic, or automatically when there is no API key to call with.
 */
function selectPicker(forceDeterministic: boolean): CartPicker {
  const apiKey = process.env['OPENROUTER_API_KEY'] ?? '';
  const usable = apiKey.length > 0 && !apiKey.startsWith('your_');

  if (forceDeterministic || !usable) {
    if (!forceDeterministic) {
      console.log('[agent] OPENROUTER_API_KEY not usable — falling back to deterministic picker');
    }
    return new DeterministicPicker();
  }

  return new LlmToolAgent({ apiKey });
}

/**
 * Runs the picker, falling back to the deterministic one on a rate limit rather than
 * failing the run — explicitly noted in the trace so a fallback is never silent.
 */
async function decide(
  picker: CartPicker,
  trace: RunTrace,
): Promise<{ result: PickResult; pickerUsed: string; fellBack: boolean }> {
  const request = { cartId: DEMO_CART_ID, items: DEMO_CART, maxAmountPaise: MAX_SPEND_PAISE };

  try {
    const result = await picker.pick(request);
    trace.record('picker.decision', { picker: picker.name, ...result });
    return { result, pickerUsed: picker.name, fellBack: false };
  } catch (error) {
    if (error instanceof PickerError && error.rateLimited) {
      // Covers both a 429 and an error-shaped 200 with no choices — either way the
      // reasoning layer is unavailable this run, and the phase must not be blocked.
      console.warn(
        `[agent] LLM unavailable (${error.message}) — falling back to deterministic picker`,
      );
      trace.record('picker.fallback', { from: picker.name, error: error.message });
      const fallback = new DeterministicPicker();
      const result = await fallback.pick(request);
      trace.record('picker.decision', { picker: fallback.name, ...result });
      return { result, pickerUsed: fallback.name, fellBack: true };
    }
    throw error;
  }
}

const program = new Command();

program.name('agent-client').description('AgentGateway reference buyer agent (Phase 4)');

program
  .command('setup')
  .description('Generate an Ed25519 keypair and register the agent with the gateway')
  .option('--gateway-url <url>', 'AgentGateway base URL', 'http://localhost:3000')
  .option('--keystore <path>', 'where to store the agent keypair', DEFAULT_KEYSTORE_PATH)
  .option('--merchant-name <name>', 'merchant to onboard against', 'agent-client-demo-merchant')
  .option('--limit <paise>', 'spending limit in paise', '1000000')
  .action(
    async (opts: { gatewayUrl: string; keystore: string; merchantName: string; limit: string }) => {
      await runSetup({
        gatewayUrl: opts.gatewayUrl,
        keystorePath: opts.keystore,
        merchantName: opts.merchantName,
        spendingLimitPaise: Number(opts.limit),
      });
    },
  );

program
  .command('run', { isDefault: true })
  .description('Drive a purchase over the chosen protocol')
  .requiredOption('--protocol <protocol>', `x402 | ap2`, parseProtocol)
  .option('--gateway-url <url>', 'AgentGateway base URL', 'http://localhost:3000')
  .option('--keystore <path>', 'agent keypair location', DEFAULT_KEYSTORE_PATH)
  .option('--trace <path>', 'where to write the run trace', '')
  .option('--deterministic', 'force the offline picker instead of the LLM', false)
  .option('--corrupt-signature', 'AP2 only: corrupt the signature to prove rejection', false)
  .action(
    async (opts: {
      protocol: AgentProtocol;
      gatewayUrl: string;
      keystore: string;
      trace: string;
      deterministic: boolean;
      corruptSignature: boolean;
    }) => {
      const keystore = loadKeystore(opts.keystore);
      if (keystore === null) {
        throw new Error(
          `no keystore at ${opts.keystore} — run: npm run setup --workspace=agent-client`,
        );
      }

      const trace = new RunTrace();
      const picker = selectPicker(opts.deterministic);

      console.log(`[agent] protocol=${opts.protocol} cart=${DEMO_CART_ID}`);
      console.log(
        `[agent] picker=${picker.name}${picker.name === 'llm-tool-agent' ? ` model=${NEMOTRON_MODEL}` : ''}`,
      );

      trace.record('run.start', {
        protocol: opts.protocol,
        cartId: DEMO_CART_ID,
        merchantId: keystore.merchantId,
        agentId: keystore.agentId,
        picker: picker.name,
        maxAmountPaise: MAX_SPEND_PAISE,
        corruptSignature: opts.corruptSignature,
      });

      const { result, pickerUsed, fellBack } = await decide(picker, trace);

      // The reasoning layer is untrusted input: re-validate its choice before spending.
      const item = findItem(result.sku);
      if (item === undefined) throw new Error(`picker chose unknown sku ${result.sku}`);
      if (item.amountPaise > MAX_SPEND_PAISE) {
        throw new Error(`picker chose ${item.sku} above the ceiling — refusing to proceed`);
      }

      console.log(`[agent] chose ${item.sku} (${item.amountPaise} paise) — ${result.reasoning}`);
      if (fellBack) console.log('[agent] NOTE: decision came from the deterministic fallback');

      let outcome = 'unknown';
      let paymentRequestId: string | null = null;

      if (opts.protocol === 'x402') {
        const client = new X402Client(opts.gatewayUrl, trace);
        const settled = await client.purchase({
          cartId: DEMO_CART_ID,
          agentId: keystore.agentId,
          merchantId: keystore.merchantId,
          amountPaise: item.amountPaise,
        });
        paymentRequestId = settled.paymentRequestId;
        outcome = settled.httpStatus === 200 ? 'redeemed' : `http_${settled.httpStatus}`;
      } else {
        const client = new Ap2Client(opts.gatewayUrl, trace);
        const settled = await client.purchase({
          agentId: keystore.agentId,
          merchantId: keystore.merchantId,
          amountPaise: item.amountPaise,
          privateKeyBase64: keystore.privateKeyBase64,
          corruptSignature: opts.corruptSignature,
        });
        paymentRequestId = settled.paymentRequestId;
        outcome =
          settled.httpStatus === 202
            ? (settled.finalStatus ?? 'accepted')
            : `http_${settled.httpStatus}`;
      }

      const tracePath =
        opts.trace.length > 0
          ? opts.trace
          : `traces/${opts.protocol}-${pickerUsed}-${Date.now()}.json`;

      const written = trace.write(tracePath, {
        protocol: opts.protocol,
        picker: pickerUsed,
        cartId: DEMO_CART_ID,
        merchantId: keystore.merchantId,
        agentId: keystore.agentId,
        outcome,
        paymentRequestId,
        razorpayOrderId: null,
      });

      console.log(`[agent] outcome=${outcome} payment_request_id=${paymentRequestId ?? 'none'}`);
      console.log(`[agent] trace (${trace.length} entries) -> ${written}`);
    },
  );

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(`[agent] failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
