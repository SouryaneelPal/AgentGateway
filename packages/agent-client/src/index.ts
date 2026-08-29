#!/usr/bin/env node
/**
 * Reference agent CLI (Phase 4) — scaffolded in Phase 1.
 *
 * The whole point of this client is the Phase 4 validation bar: both protocol runs,
 * against the identical cart and identical merchant, must terminate in the same
 * razorpay_orders row shape underneath. Same cart, same money, two protocols.
 *
 *   npm run dev --workspace=agent-client -- --protocol=x402
 *   npm run dev --workspace=agent-client -- --protocol=ap2
 */

import { Command } from 'commander';
import { X402Client } from './x402-client.js';
import { Ap2Client } from './ap2-client.js';

const PROTOCOLS = ['x402', 'ap2'] as const;
export type AgentProtocol = (typeof PROTOCOLS)[number];

export interface AgentRunOptions {
  readonly protocol: AgentProtocol;
  readonly gatewayUrl: string;
  readonly cartId: string;
  readonly tracePath: string;
}

function parseProtocol(value: string): AgentProtocol {
  const match = PROTOCOLS.find((protocol) => protocol === value);
  if (match === undefined) {
    throw new Error(`--protocol must be one of: ${PROTOCOLS.join(', ')} (received "${value}")`);
  }
  return match;
}

async function run(options: AgentRunOptions): Promise<void> {
  console.log(`[agent] protocol=${options.protocol} cart=${options.cartId}`);
  console.log(`[agent] gateway=${options.gatewayUrl}`);

  const client =
    options.protocol === 'x402'
      ? new X402Client(options.gatewayUrl)
      : new Ap2Client(options.gatewayUrl);

  await client.purchase(options.cartId);
}

const program = new Command();

program
  .name('agent-client')
  .description('AgentGateway reference buyer agent (Phase 4 — scaffold only)')
  .requiredOption(
    '--protocol <protocol>',
    `protocol to transact over: ${PROTOCOLS.join(' | ')}`,
    parseProtocol,
  )
  .option('--gateway-url <url>', 'AgentGateway base URL', 'http://localhost:3000')
  .option('--cart-id <id>', 'cart to purchase', 'cart_demo_001')
  .option('--trace <path>', 'where to write the full request/response trace', './traces/run.json')
  .action(
    async (raw: { protocol: AgentProtocol; gatewayUrl: string; cartId: string; trace: string }) => {
      try {
        await run({
          protocol: raw.protocol,
          gatewayUrl: raw.gatewayUrl,
          cartId: raw.cartId,
          tracePath: raw.trace,
        });
      } catch (error) {
        console.error(`[agent] failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
    },
  );

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
