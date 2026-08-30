/**
 * Protocol router (§2.1 "Protocol Router", §2.2) — IMPLEMENTED (Phase 3).
 *
 * §2.2: "the router doesn't need to know anything protocol-specific — it just needs to
 * know which adapter to hand a request to."
 *
 * That property is enforced structurally here. This file contains ZERO protocol
 * knowledge: no header names, no body field names, no URL patterns. It walks an ordered
 * registry and asks each adapter `matches(request)`. Each detection rule lives with the
 * adapter that owns it, so adding UAP later (§5.2) means writing one adapter class and
 * appending it to REGISTRY — nothing in this file changes.
 *
 * Order matters only in that fallbackAdapter matches everything and therefore must be
 * consulted last; that is the graceful-degradation guarantee from §2.2.
 */

import { ap2Adapter } from './ap2.adapter.js';
import { x402Adapter } from './x402.adapter.js';
import { fallbackAdapter } from './fallback.adapter.js';
import type { IncomingRequest, RoutableProtocolAdapter } from './protocol-adapter.interface.js';

/**
 * Specific adapters first; the catch-all last. The router never inspects what makes an
 * entry specific — only the position in this list encodes precedence.
 */
const REGISTRY: readonly RoutableProtocolAdapter[] = [x402Adapter, ap2Adapter, fallbackAdapter];

export interface RoutingDecision {
  readonly adapter: RoutableProtocolAdapter;
  /** True when nothing specific claimed the request and it fell through to fallback. */
  readonly viaFallback: boolean;
}

/**
 * Picks the adapter for an incoming request. Never throws and never returns null: an
 * unrecognised client degrades to the fallback Payment Link path rather than failing,
 * which is the behaviour §2.2 calls "part of the design, not an afterthought".
 */
export function routeRequest(request: IncomingRequest): RoutingDecision {
  for (const adapter of REGISTRY) {
    if (adapter.matches(request)) {
      return { adapter, viaFallback: adapter.protocolName === 'fallback' };
    }
  }

  // Unreachable while fallbackAdapter.matches() returns true, but a registry
  // misconfiguration should degrade rather than crash the request path.
  return { adapter: fallbackAdapter, viaFallback: true };
}

/** Exposed for tests and for the Phase 5 protocol-tester panel. */
export function registeredProtocols(): readonly string[] {
  return REGISTRY.map((adapter) => adapter.protocolName);
}
