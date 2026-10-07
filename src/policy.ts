import type { Effect } from "./define.js"

/** What the host's hook sees. `input` is the already-validated input. */
export interface BeforeExecuteContext {
  connector: string
  action: string
  effect: Effect
  input: unknown
  connectionId: string
}

export type BeforeExecuteDecision = { allow: true } | { allow: false; reason?: string }

/**
 * ADR-007: the kit ships no policy. The host decides, using the action's `effect`
 * label (and anything else it knows) to allow, deny, or ask a human first.
 * Runs once per call (not per retry), after validation and before any network I/O.
 * If it throws, the action does NOT run (fail closed).
 */
export type BeforeExecute = (context: BeforeExecuteContext) => BeforeExecuteDecision | Promise<BeforeExecuteDecision>
