/**
 * Offline reasoning layer (Phase 4).
 *
 * Implements CartPicker with no model and no network. Retained deliberately rather than
 * deleted once the LLM picker landed: it is the fallback when OpenRouter's free tier
 * rate-limits, the picker used by tests that must not depend on a third-party API, and
 * the control case proving that a run's settlement shape does not depend on which
 * reasoning layer produced the decision.
 */

import type { CartPicker, PickRequest, PickResult } from './picker.js';
import { PickerError } from './picker.js';

export class DeterministicPicker implements CartPicker {
  readonly name = 'deterministic-picker';

  async pick(request: PickRequest): Promise<PickResult> {
    const affordable = request.items
      .filter((item) => item.amountPaise <= request.maxAmountPaise)
      .sort((a, b) => a.amountPaise - b.amountPaise);

    const chosen = affordable[0];

    if (chosen === undefined) {
      throw new PickerError(
        this.name,
        `no item in cart ${request.cartId} costs <= ${request.maxAmountPaise} paise`,
      );
    }

    return {
      sku: chosen.sku,
      amountPaise: chosen.amountPaise,
      reasoning: `Cheapest item at or under the ${request.maxAmountPaise} paise ceiling.`,
      pickedBy: 'deterministic',
      toolCalls: [],
    };
  }
}
