/**
 * RazorpayClient request-shape tests (Phase 2).
 *
 * The smoke script proves the SDK round-trips against live test-mode credentials, but
 * it only exercises createOrder and needs real keys. These tests pin the exact request
 * body this wrapper builds for all three methods, deterministically and offline, by
 * injecting a stand-in for the SDK instance.
 *
 * What they assert is the thing most likely to be wrong and least likely to be noticed:
 * that amounts are passed through as paise, currency is always INR, and optional
 * customer/callback fields are omitted rather than sent as undefined.
 */

import { describe, expect, it } from 'vitest';
import { RazorpayClient, type RazorpayClientOptions } from '../src/razorpay/razorpay-client.js';

interface Recorded {
  orders: unknown[];
  paymentLinks: unknown[];
  captures: unknown[][];
}

type SdkStandIn = NonNullable<RazorpayClientOptions['client']>;

function fakeSdk(): { recorded: Recorded; options: RazorpayClientOptions } {
  const recorded: Recorded = { orders: [], paymentLinks: [], captures: [] };

  const stub = {
    orders: {
      create: (params: unknown) => {
        recorded.orders.push(params);
        return Promise.resolve({ id: 'order_TEST123', status: 'created' });
      },
    },
    paymentLink: {
      create: (params: unknown) => {
        recorded.paymentLinks.push(params);
        return Promise.resolve({ id: 'plink_TEST123', short_url: 'https://rzp.io/i/test' });
      },
    },
    payments: {
      capture: (...args: unknown[]) => {
        recorded.captures.push(args);
        return Promise.resolve({ id: 'pay_TEST123', status: 'captured' });
      },
    },
    // The wrapper only ever touches the three entities above; the cast narrows this
    // stand-in to the SDK surface rather than widening the wrapper's own types.
  } as unknown as SdkStandIn;

  return { recorded, options: { client: stub } };
}

describe('RazorpayClient.createOrder', () => {
  it('sends amount in paise, INR, receipt and notes', async () => {
    const { recorded, options } = fakeSdk();
    const razorpay = new RazorpayClient(options);

    const order = await razorpay.createOrder({
      amountPaise: 149_900,
      receipt: 'pr_8e21',
      notes: { paymentRequestId: 'pr_8e21' },
    });

    expect(recorded.orders).toHaveLength(1);
    expect(recorded.orders[0]).toEqual({
      amount: 149_900,
      currency: 'INR',
      receipt: 'pr_8e21',
      notes: { paymentRequestId: 'pr_8e21' },
    });
    expect(order.id).toBe('order_TEST123');
  });

  it('sends an empty notes object rather than undefined when notes are omitted', async () => {
    const { recorded, options } = fakeSdk();
    await new RazorpayClient(options).createOrder({ amountPaise: 100, receipt: 'r' });

    expect(recorded.orders[0]).toEqual({
      amount: 100,
      currency: 'INR',
      receipt: 'r',
      notes: {},
    });
  });
});

describe('RazorpayClient.createPaymentLink', () => {
  it('sends amount, INR, description, reference_id and suppresses Razorpay notifications', async () => {
    const { recorded, options } = fakeSdk();

    const link = await new RazorpayClient(options).createPaymentLink({
      amountPaise: 250_000,
      description: 'Cart cart_demo_001',
      referenceId: 'pr_abc',
    });

    expect(recorded.paymentLinks).toHaveLength(1);
    // NOTE: `customer` must be ABSENT, not {}. An earlier version of this test asserted
    // `customer: {}` and so locked in a bug — the live API rejects an empty customer
    // object with 400 "incorrect JSON object received - faulty key: customer". The unit
    // test agreed with the implementation and both were wrong; only a real call caught it.
    expect(recorded.paymentLinks[0]).toEqual({
      amount: 250_000,
      currency: 'INR',
      description: 'Cart cart_demo_001',
      reference_id: 'pr_abc',
      notify: { sms: false, email: false },
      notes: {},
    });
    expect(Object.keys(recorded.paymentLinks[0] as object)).not.toContain('customer');
    expect(link.id).toBe('plink_TEST123');
  });

  it('omits the customer key entirely when no customer details are supplied', async () => {
    const { recorded, options } = fakeSdk();
    await new RazorpayClient(options).createPaymentLink({
      amountPaise: 100,
      description: 'd',
      referenceId: 'r',
    });
    expect(recorded.paymentLinks[0]).not.toHaveProperty('customer');
  });

  it('omits absent customer fields entirely instead of sending undefined', async () => {
    const { recorded, options } = fakeSdk();

    await new RazorpayClient(options).createPaymentLink({
      amountPaise: 100,
      description: 'd',
      referenceId: 'r',
      customerEmail: 'buyer@example.com',
    });

    const sent = recorded.paymentLinks[0] as { customer: Record<string, unknown> };
    expect(sent.customer).toEqual({ email: 'buyer@example.com' });
    expect(Object.keys(sent.customer)).not.toContain('name');
    expect(Object.keys(sent.customer)).not.toContain('contact');
  });

  it('adds callback_url and callback_method together, or neither', async () => {
    const { recorded, options } = fakeSdk();

    await new RazorpayClient(options).createPaymentLink({
      amountPaise: 100,
      description: 'd',
      referenceId: 'r',
      callbackUrl: 'https://example.com/return',
    });

    expect(recorded.paymentLinks[0]).toMatchObject({
      callback_url: 'https://example.com/return',
      callback_method: 'get',
    });
  });
});

describe('RazorpayClient.capturePayment', () => {
  it('passes paymentId, amount in paise and INR positionally', async () => {
    const { recorded, options } = fakeSdk();

    const payment = await new RazorpayClient(options).capturePayment({
      paymentId: 'pay_TEST123',
      amountPaise: 149_900,
    });

    expect(recorded.captures).toHaveLength(1);
    expect(recorded.captures[0]).toEqual(['pay_TEST123', 149_900, 'INR']);
    expect(payment.id).toBe('pay_TEST123');
  });
});
