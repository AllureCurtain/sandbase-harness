/**
 * Loop Engine Admission
 *
 * Resolves the engine a caller requested for a new session against the shipped
 * Settings adapter descriptors. This is the only place that turns a raw
 * `loop_engine` value into a persisted engine, so every ingress path fails
 * closed with the same stable error codes:
 *
 * - a value outside the public contract → `loop_engine_invalid`;
 * - a recognized roadmap engine → `loop_engine_not_supported` plus its reason.
 *
 * Nothing here silently falls back to `builtin`. A caller that omits the field
 * gets the effective Settings default; a caller that asks for an engine this
 * runtime cannot execute gets an error.
 */

import {
  LOOP_ENGINE_ADAPTER_IDS,
  describeLoopEngineAdapters,
  loopEngineDescriptor,
} from '@/core/settings/adapters.js';
import type { SessionLoopEngine } from '@/types/session.js';

/** Stable public error code for an engine this runtime does not implement. */
export const LOOP_ENGINE_UNSUPPORTED_CODE = 'loop_engine_not_supported';

/** Stable public error code for a value outside the public engine contract. */
export const LOOP_ENGINE_INVALID_CODE = 'loop_engine_invalid';

/** Reason used when the adapter exists but no execution strategy was registered. */
export const LOOP_ENGINE_NOT_REGISTERED_REASON =
  'No execution strategy is registered for this loop engine in the running runtime.';

export class LoopEngineUnsupportedError extends Error {
  readonly code = LOOP_ENGINE_UNSUPPORTED_CODE;

  constructor(readonly engine: string, readonly reason: string) {
    super(`Loop engine "${engine}" is not available in this runtime: ${reason}`);
    this.name = 'LoopEngineUnsupportedError';
  }
}

export class LoopEngineInvalidError extends Error {
  readonly code = LOOP_ENGINE_INVALID_CODE;

  constructor(readonly engine: string) {
    super(`loop_engine must be one of ${LOOP_ENGINE_ADAPTER_IDS.join(', ')}`);
    this.name = 'LoopEngineInvalidError';
  }
}

export type LoopEngineAdmissionError = LoopEngineUnsupportedError | LoopEngineInvalidError;

/** Maps loop-engine admission failures to the stable API error shape. */
export function isLoopEngineAdmissionError(error: unknown): error is LoopEngineAdmissionError {
  return error instanceof LoopEngineUnsupportedError || error instanceof LoopEngineInvalidError;
}

/**
 * Resolve a request-level `loop_engine` value.
 *
 * Returns `undefined` when the field was omitted, which means "use the
 * effective Settings default". Throws for unknown values and for recognized
 * engines that this runtime cannot execute.
 */
export function resolveRequestedLoopEngine(value: unknown): SessionLoopEngine | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new LoopEngineInvalidError(String(value));

  const declared = describeLoopEngineAdapters().find((item) => item.id === value);
  if (!declared) throw new LoopEngineInvalidError(value);
  if (declared.status !== 'available') {
    throw new LoopEngineUnsupportedError(value, declared.reason ?? 'This engine is not available in this runtime.');
  }
  return declared.id as SessionLoopEngine;
}

/**
 * Assert a resolved engine can actually be dispatched by this process. The
 * descriptor list says the *adapter* ships; this says a strategy instance was
 * registered for it, which is what a turn needs. Both are checked before the
 * session row, event log, or sandbox are touched.
 */
export function assertLoopEngineExecutable(
  engine: SessionLoopEngine,
  isRegistered: (engine: SessionLoopEngine) => boolean,
): void {
  if (isRegistered(engine)) return;
  throw new LoopEngineUnsupportedError(
    engine,
    loopEngineDescriptor(engine)?.reason ?? LOOP_ENGINE_NOT_REGISTERED_REASON,
  );
}
