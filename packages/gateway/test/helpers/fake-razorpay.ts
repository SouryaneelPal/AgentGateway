/**
 * A stand-in for the Razorpay SDK, so the Phase 3 adapter tests exercise the real
 * settlement code path without live test-mode credentials or a network call.
 *
 * It records what was asked of it, so tests can assert that the adapters build the
 * correct Orders and Payment Links — the same assertions the Phase 2 RazorpayClient
 * tests make, now reached through the full adapter pipeline.
 */

import { RazorpayClient, type RazorpayClientOptions } from '../../src/razorpay/razorpay-client.js';
import { setRazorpayClientForTesting } from '../../src/adapters/adapter-support.js';

export interface FakeRazorpayRecord {
  orders: Array<Record<string, unknown>>;
  paymentLinks: Array<Record<string, unknown>>;
  captures: unknown[][];
}

type SdkStandIn = NonNullable<RazorpayClientOptions['client']>;

export interface InstalledFakeRazorpay {
  readonly recorded: FakeRazorpayRecord;
  /** The order id the next createOrder call will return. */
  nextOrderId(): string;
  restore(): void;
}

let counter = 0;

/**
 * Installs the fake for the duration of a test and returns a restore function.
 * Always restore in afterEach — a leaked fake would silently disarm later tests.
 */
export function installFakeRazorpay(): InstalledFakeRazorpay {
  const recorded: FakeRazorpayRecord = { orders: [], paymentLinks: [], captures: [] };
  const issuedOrderIds: string[] = [];

  const stub = {
    orders: {
      create: (params: Record<string, unknown>) => {
        counter += 1;
        const id = `order_FAKE${String(counter).padStart(10, '0')}`;
        issuedOrderIds.push(id);
        recorded.orders.push(params);
        return Promise.resolve({ id, status: 'created', amount: params['amount'] });
      },
    },
    paymentLink: {
      create: (params: Record<string, unknown>) => {
        counter += 1;
        const id = `plink_FAKE${String(counter).padStart(10, '0')}`;
        recorded.paymentLinks.push(params);
        return Promise.resolve({ id, short_url: `https://rzp.io/i/${id}`, status: 'created' });
      },
    },
    payments: {
      capture: (...args: unknown[]) => {
        recorded.captures.push(args);
        return Promise.resolve({ id: 'pay_FAKE', status: 'captured' });
      },
    },
  } as unknown as SdkStandIn;

  const restore = setRazorpayClientForTesting(new RazorpayClient({ client: stub }));

  return {
    recorded,
    nextOrderId: () => issuedOrderIds[issuedOrderIds.length - 1] ?? '',
    restore,
  };
}
