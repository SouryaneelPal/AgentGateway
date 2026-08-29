/**
 * Error taxonomy for the gateway.
 *
 * Phase 1 scaffolds structure only, so most of the request path deliberately throws
 * NotImplementedError. `server.ts` maps it to HTTP 501 so an unimplemented route is
 * visibly unimplemented rather than a silent 500.
 */

/** Thrown by anything scaffolded in Phase 1 whose behaviour lands in a later phase. */
export class NotImplementedError extends Error {
  readonly subject: string;
  readonly phase: string;

  constructor(subject: string, phase: string) {
    super(
      `${subject} is not implemented yet — scaffolded in Phase 1, lands in ${phase}. See ROADMAP.md.`,
    );
    this.name = 'NotImplementedError';
    this.subject = subject;
    this.phase = phase;
  }
}

/**
 * A typed, machine-readable rejection — the shape §3.5 insists on for a spend-cap
 * breach ("not a generic 500"). Carried here in Phase 1 so the Policy Engine has a
 * contract to fill in during Phase 2.
 */
export class PolicyRejectionError extends Error {
  readonly code: string;
  readonly detail: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, detail: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = 'PolicyRejectionError';
    this.code = code;
    this.detail = detail;
  }
}
