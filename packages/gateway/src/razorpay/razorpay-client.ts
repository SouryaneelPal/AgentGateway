/**
 * Razorpay client wrapper (§2.1 "Razorpay Test-Mode APIs") — IMPLEMENTED.
 *
 * Razorpay's Orders / Payment Links APIs are the ONLY settlement primitive in the
 * system. Everything upstream — adapters, policy, mandates — exists to decide whether
 * to call into this module; nothing else moves money.
 *
 * Response types are re-exported from the SDK's own entity namespaces rather than
 * restated by hand, so they cannot drift out of sync with the installed razorpay
 * version and no `any` is needed to bridge the gap. (They are taken from the namespaces
 * directly rather than derived via ReturnType, because each SDK method is overloaded
 * with a callback variant whose return type is `void`.)
 */

import Razorpay from 'razorpay';
import type { Orders } from 'razorpay/types/orders.js';
import type { PaymentLinks } from 'razorpay/types/paymentLink.js';
import type { Payments } from 'razorpay/types/payments.js';
import { env } from '../config/env.js';

type RazorpayInstance = InstanceType<typeof Razorpay>;

export type RazorpayOrder = Orders.RazorpayOrder;
export type RazorpayPaymentLink = PaymentLinks.RazorpayPaymentLink;
export type RazorpayPayment = Payments.RazorpayPayment;

/**
 * The SDK's own type declares `customer` as REQUIRED on a Payment Link create body.
 * That is wrong about the live API: sending `customer: {}` is rejected with
 *   400 BAD_REQUEST_ERROR "incorrect JSON object received - faulty key: customer"
 * while omitting the key entirely succeeds. This local type corrects the SDK's
 * declaration so the omission can be expressed without reaching for `any`.
 */
type PaymentLinkPayload = Omit<PaymentLinks.RazorpayPaymentLinkCreateRequestBody, 'customer'> & {
  customer?: PaymentLinks.RazorpayPaymentLinkCreateRequestBody['customer'];
};

export interface CreateOrderInput {
  /** Amount in paise — the gateway's only internal money unit (§2.2). */
  readonly amountPaise: number;
  /** Idempotent, human-traceable receipt id. Razorpay caps this at 40 characters. */
  readonly receipt: string;
  /** Copied onto the order so a webhook can be traced back to a payment_request. */
  readonly notes?: Readonly<Record<string, string>>;
}

export interface CreatePaymentLinkInput {
  readonly amountPaise: number;
  readonly description: string;
  readonly referenceId: string;
  readonly customerName?: string;
  readonly customerEmail?: string;
  readonly customerContact?: string;
  readonly callbackUrl?: string;
  readonly notes?: Readonly<Record<string, string>>;
}

export interface CapturePaymentInput {
  readonly paymentId: string;
  readonly amountPaise: number;
}

export interface RazorpayClientOptions {
  readonly keyId?: string;
  readonly keySecret?: string;
  /**
   * Test seam. Injecting a stand-in for the SDK instance is what lets the unit tests
   * assert the exact request bodies this wrapper builds, without holding live
   * test-mode credentials or making a network call.
   */
  readonly client?: RazorpayInstance;
}

/**
 * Thin, typed wrapper over the Razorpay Node SDK, pinned to INR.
 *
 * Currency is hard-coded rather than parameterised: §2.2's NormalizedPaymentRequest
 * declares `currency: 'INR'` as a literal type, so a second currency would be a
 * design change, not a config change.
 */
export class RazorpayClient {
  private readonly client: RazorpayInstance;

  constructor(options: RazorpayClientOptions = {}) {
    this.client =
      options.client ??
      new Razorpay({
        key_id: options.keyId ?? env.RAZORPAY_KEY_ID,
        key_secret: options.keySecret ?? env.RAZORPAY_KEY_SECRET,
      });
  }

  /** Creates a Razorpay Order. Capture is confirmed by webhook, never by polling (§1.3). */
  async createOrder(input: CreateOrderInput): Promise<RazorpayOrder> {
    return this.client.orders.create({
      amount: input.amountPaise,
      currency: 'INR',
      receipt: input.receipt,
      notes: { ...input.notes },
    });
  }

  /** Creates a Payment Link — the fallbackAdapter's human-tap settlement path (§2.2). */
  async createPaymentLink(input: CreatePaymentLinkInput): Promise<RazorpayPaymentLink> {
    const customer = {
      ...(input.customerName === undefined ? {} : { name: input.customerName }),
      ...(input.customerEmail === undefined ? {} : { email: input.customerEmail }),
      ...(input.customerContact === undefined ? {} : { contact: input.customerContact }),
    };

    // Built as a mutable payload rather than one object literal: a conditional spread
    // makes the property optional in the inferred type, which under
    // exactOptionalPropertyTypes pushes the SDK onto the wrong `create` overload.
    const payload: PaymentLinkPayload = {
      amount: input.amountPaise,
      currency: 'INR',
      description: input.description,
      reference_id: input.referenceId,
      notify: { sms: false, email: false },
      notes: { ...input.notes },
    };

    // Razorpay rejects an EMPTY customer object outright:
    //   BAD_REQUEST_ERROR "incorrect JSON object received - faulty key: customer"
    // so the key must be omitted entirely when there are no customer details, not
    // sent as {}. Found by a live Payment Link call; the original unit test asserted
    // `customer: {}` and so pinned this bug in place rather than catching it.
    if (Object.keys(customer).length > 0) {
      payload.customer = customer;
    }

    if (input.callbackUrl !== undefined) {
      payload.callback_url = input.callbackUrl;
      payload.callback_method = 'get';
    }

    // Single narrow cast, back onto the SDK's (incorrect) declared shape. Confined to
    // this one line so the corrected type governs everything above it.
    return this.client.paymentLink.create(
      payload as PaymentLinks.RazorpayPaymentLinkCreateRequestBody,
    );
  }

  /** Captures an authorised payment. */
  async capturePayment(input: CapturePaymentInput): Promise<RazorpayPayment> {
    return this.client.payments.capture(input.paymentId, input.amountPaise, 'INR');
  }

  /** Escape hatch for Phase 2+ calls this wrapper does not cover yet. */
  get raw(): RazorpayInstance {
    return this.client;
  }
}

export const razorpayClient = new RazorpayClient();
