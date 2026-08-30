/**
 * Fixture catalogue for the reference agent (Phase 4).
 *
 * Deliberately static: the point of the Phase 4 validation is that BOTH protocol runs
 * purchase the IDENTICAL cart against the IDENTICAL merchant and land in the same
 * razorpay_orders shape. A varying catalogue would destroy that comparison.
 */

import type { CartItem } from './picker.js';

export const DEMO_CART_ID = 'cart_demo_001';

/** Ceiling handed to the picker, and re-checked by the caller afterwards. */
export const MAX_SPEND_PAISE = 60_000;

export const DEMO_CART: readonly CartItem[] = [
  {
    sku: 'SKU-COFFEE-250G',
    name: 'Single-origin coffee, 250g',
    amountPaise: 45_000,
    category: 'grocery',
  },
  {
    sku: 'SKU-NOTEBOOK-A5',
    name: 'A5 dotted notebook',
    amountPaise: 25_000,
    category: 'stationery',
  },
  {
    sku: 'SKU-CABLE-USBC',
    name: 'USB-C braided cable, 1m',
    amountPaise: 55_000,
    category: 'electronics',
  },
  { sku: 'SKU-DESKMAT-XL', name: 'Desk mat, XL', amountPaise: 120_000, category: 'electronics' },
];

export function findItem(sku: string): CartItem | undefined {
  return DEMO_CART.find((item) => item.sku === sku);
}
