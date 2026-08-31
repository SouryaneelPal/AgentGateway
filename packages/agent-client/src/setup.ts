/**
 * Agent onboarding (Phase 4 deliverable).
 *
 * "The agent generates its own Ed25519 keypair for the AP2 run and registers its public
 * key via a setup script (simulating merchant-side agent onboarding)."
 *
 * The keypair is generated HERE, in the agent's own process, and the private key is
 * written to a local keystore that never leaves this machine. Only the public key is
 * sent to the gateway. That is §3.1's guarantee — "the private key never touches the
 * gateway" — enforced by where the code runs, not by policy.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { generateKeypair, type Ed25519Keypair } from './ap2-client.js';

export interface AgentKeystore {
  readonly agentId: string;
  readonly merchantId: string;
  readonly agentIdentityId: string;
  readonly publicKeyBase64: string;
  readonly privateKeyBase64: string;
  readonly createdAt: string;
}

export const DEFAULT_KEYSTORE_PATH = '.agent-keystore.json';

export function loadKeystore(path: string = DEFAULT_KEYSTORE_PATH): AgentKeystore | null {
  const absolute = resolve(path);
  if (!existsSync(absolute)) return null;
  try {
    return JSON.parse(readFileSync(absolute, 'utf8')) as AgentKeystore;
  } catch {
    return null;
  }
}

/** Owner-only. This file holds the agent's Ed25519 PRIVATE key. */
const KEYSTORE_FILE_MODE = 0o600;
const KEYSTORE_DIR_MODE = 0o700;

function saveKeystore(keystore: AgentKeystore, path: string): string {
  const absolute = resolve(path);

  // The private key in this file is what authorizes AP2 mandates — i.e. what authorizes
  // spending. writeFileSync defaults to 0644 (minus umask), which on a shared machine
  // leaves it readable by every local user.
  mkdirSync(dirname(absolute), { recursive: true, mode: KEYSTORE_DIR_MODE });
  writeFileSync(absolute, `${JSON.stringify(keystore, null, 2)}\n`, {
    encoding: 'utf8',
    mode: KEYSTORE_FILE_MODE,
  });

  // `mode` above only applies when the file is CREATED. Re-running setup over an
  // existing keystore would otherwise silently keep whatever permissions that file
  // already had, so the mode is asserted explicitly afterwards.
  chmodSync(absolute, KEYSTORE_FILE_MODE);

  return absolute;
}

interface RegisterResponse {
  agent_identity_id: string;
  merchant_id: string;
  protocol: string;
  external_agent_id: string;
  trust_level: string;
  spending_limit_paise: number;
}

async function register(
  gatewayUrl: string,
  apiKey: string,
  payload: Record<string, unknown>,
): Promise<RegisterResponse> {
  const response = await fetch(`${gatewayUrl}/v1/merchant/agents/register`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // Phase 4.5: /v1/merchant/* requires a merchant API key, and the merchant is
      // derived from it server-side.
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  const body: unknown = await response.json().catch(() => null);

  if (response.status === 401) {
    throw new Error(
      'registration rejected: invalid or missing merchant API key. Mint one with:\n' +
        '  npm run merchant:create --workspace=gateway -- --name "My Merchant"',
    );
  }

  if (response.status !== 201) {
    throw new Error(`registration failed: HTTP ${response.status} ${JSON.stringify(body)}`);
  }

  return body as RegisterResponse;
}

export interface SetupOptions {
  readonly gatewayUrl: string;
  readonly keystorePath: string;
  /** Merchant API key. The merchant identity is derived from it server-side. */
  readonly apiKey: string;
  readonly spendingLimitPaise: number;
  readonly agentId?: string;
}

/**
 * Registers BOTH protocol identities against the SAME merchant. That shared merchant is
 * what makes the Phase 4 validation meaningful: two protocols, one merchant, one cart —
 * so any difference in the resulting razorpay_orders row is attributable to the protocol
 * and nothing else.
 *
 * STRUCTURAL CHANGE IN PHASE 4.5 — this is more than a new header. Previously this
 * script CREATED the merchant on its first call (by passing merchantName) and then
 * threaded the returned merchantId into the second call. Both halves are now gone:
 *   - merchant creation moved out entirely, to the operator script
 *     `npm run merchant:create --workspace=gateway`, because a merchant cannot be
 *     bootstrapped through a surface that requires that merchant's own key.
 *   - the second call no longer passes merchantId. Both registrations land on the SAME
 *     merchant because they present the SAME API KEY, and the server derives the
 *     merchant from it. That is what closes the cross-tenant IDOR: the client can no
 *     longer name a merchant at all.
 */
export async function runSetup(options: SetupOptions): Promise<AgentKeystore> {
  const keypair: Ed25519Keypair = generateKeypair();
  const agentId = options.agentId ?? `ref-agent-${Date.now().toString(36)}`;

  // AP2 first — it carries the public key.
  const ap2 = await register(options.gatewayUrl, options.apiKey, {
    protocol: 'ap2',
    externalAgentId: agentId,
    publicKey: keypair.publicKeyBase64,
    spendingLimitPaise: options.spendingLimitPaise,
  });

  // x402 identity for the same agent. Same merchant, because same key — not because
  // the client asserted a merchant id.
  const x402 = await register(options.gatewayUrl, options.apiKey, {
    protocol: 'x402',
    externalAgentId: agentId,
    spendingLimitPaise: options.spendingLimitPaise,
  });

  const keystore: AgentKeystore = {
    agentId,
    merchantId: ap2.merchant_id,
    agentIdentityId: ap2.agent_identity_id,
    publicKeyBase64: keypair.publicKeyBase64,
    privateKeyBase64: keypair.privateKeyBase64,
    createdAt: new Date().toISOString(),
  };

  const saved = saveKeystore(keystore, options.keystorePath);

  console.log('\n============================================================');
  console.log('  AGENT ONBOARDED');
  console.log('============================================================');
  console.log(`  agent id            ${agentId}`);
  console.log(`  merchant id         ${ap2.merchant_id}`);
  console.log(`  ap2 identity        ${ap2.agent_identity_id}  (trust: ${ap2.trust_level})`);
  console.log(`  x402 identity       ${x402.agent_identity_id}  (trust: ${x402.trust_level})`);
  console.log(`  spending limit      ${ap2.spending_limit_paise} paise`);
  console.log('');
  console.log('  Ed25519 PUBLIC KEY (registered with the gateway):');
  console.log(`  ${keypair.publicKeyBase64}`);
  console.log('');
  console.log(`  private key stored locally (owner-only, 0600), never sent: ${saved}`);
  console.log('============================================================\n');

  return keystore;
}
