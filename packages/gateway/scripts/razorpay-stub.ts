/**
 * A stand-in for the Razorpay SDK instance, shared by the measurement scripts.
 *
 * Extracted from loadtest-gateway-only.ts (Phase 7) when the soak test needed the same
 * stub: two copies of this would have been free to drift, and a measurement harness that
 * quietly stops matching the one it is compared against is worse than no harness.
 *
 * It replaces the SDK INSTANCE, not our RazorpayClient — our own wrapper still builds the
 * request bodies, pins INR and shapes the notes on every call. Only the network boundary
 * is removed. Returns immediately, with no artificial delay: the point is to take the
 * network out of the measurement so what remains is unambiguously the gateway's own work.
 */

import type { RazorpayClientOptions } from '../src/razorpay/razorpay-client.js';

export function createStubSdk(): NonNullable<RazorpayClientOptions['client']> {
  let counter = 0;
  const stub = {
    orders: {
      create: async (body: { amount: number; receipt: string; notes?: unknown }) => {
        counter += 1;
        return {
          id: `order_stub${String(counter).padStart(10, '0')}`,
          entity: 'order',
          amount: body.amount,
          amount_paid: 0,
          amount_due: body.amount,
          currency: 'INR',
          receipt: body.receipt,
          status: 'created',
          attempts: 0,
          notes: body.notes ?? {},
          created_at: Math.floor(Date.now() / 1000),
        };
      },
    },
    paymentLinks: {
      create: async (body: { amount: number; reference_id?: string }) => {
        counter += 1;
        return {
          id: `plink_stub${String(counter).padStart(10, '0')}`,
          amount: body.amount,
          currency: 'INR',
          reference_id: body.reference_id,
          short_url: `https://rzp.io/i/stub${counter}`,
          status: 'created',
        };
      },
    },
  };
  return stub as unknown as NonNullable<RazorpayClientOptions['client']>;
}
