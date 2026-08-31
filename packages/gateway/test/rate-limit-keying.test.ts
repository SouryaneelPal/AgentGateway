/**
 * Rate-limit KEYING (Phase 6 regression guard).
 *
 * Phase 4.5 documented the payment-facing limiter as keyed per agent identity. It was
 * not: @fastify/rate-limit's keyGenerator runs in an onRequest hook by default, before
 * body parsing, so the agentId read from the body was always undefined and every agent
 * silently shared one IP-keyed bucket.
 *
 * Nothing failed — the limiter still limited, just on the wrong key — which is exactly
 * why it survived. A limiter doing a different job than the one documented is worth a
 * test of its own.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

function remainingFor(headers: Record<string, unknown>): number {
  return Number(headers['x-ratelimit-remaining']);
}

async function callAs(agentId: string) {
  return app.inject({
    method: 'POST',
    url: '/v1/ap2/mandates',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ agentId }),
  });
}

describe('payment-facing rate limiting is keyed per agent identity', () => {
  it('gives two different agents independent budgets', async () => {
    const alice = `rl-alice-${Date.now()}`;
    const bob = `rl-bob-${Date.now()}`;

    const aliceFirst = remainingFor((await callAs(alice)).headers);
    const bobFirst = remainingFor((await callAs(bob)).headers);
    const aliceSecond = remainingFor((await callAs(alice)).headers);
    const bobSecond = remainingFor((await callAs(bob)).headers);

    // Each agent's own counter decrements by one across its own two calls.
    expect(aliceSecond).toBe(aliceFirst - 1);
    expect(bobSecond).toBe(bobFirst - 1);

    // The decisive assertion: bob's first call must NOT have been charged to alice.
    // Under the old onRequest keying both shared a bucket and bobFirst would have been
    // aliceFirst - 1.
    expect(bobFirst).toBe(aliceFirst);
  });

  it('charges repeated calls from one agent to that agent', async () => {
    const agent = `rl-solo-${Date.now()}`;
    const first = remainingFor((await callAs(agent)).headers);
    const second = remainingFor((await callAs(agent)).headers);
    const third = remainingFor((await callAs(agent)).headers);

    expect(second).toBe(first - 1);
    expect(third).toBe(first - 2);
  });

  it('exempts the webhook route entirely', async () => {
    // Dropping a settlement confirmation because Razorpay burst is worse than the burst.
    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/razorpay',
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(response.headers['x-ratelimit-limit']).toBeUndefined();
    expect(response.statusCode).not.toBe(429);
  });
});
