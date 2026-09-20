/**
 * Unit tests for loop-engine admission.
 *
 * The admission module is the only place a raw `loop_engine` value becomes a
 * persisted engine, so these tests pin the two stable failure codes, the
 * omitted-means-default rule, and the fact that nothing falls back silently.
 */

import { describe, expect, it } from 'vitest';
import {
  LOOP_ENGINE_INVALID_CODE,
  LOOP_ENGINE_NOT_REGISTERED_REASON,
  LOOP_ENGINE_UNSUPPORTED_CODE,
  LoopEngineInvalidError,
  LoopEngineUnsupportedError,
  assertLoopEngineExecutable,
  isLoopEngineAdmissionError,
  resolveRequestedLoopEngine,
} from '@/core/session/loop-engine-admission.js';
import {
  EXECUTABLE_LOOP_ENGINE_IDS,
  LOOP_ENGINE_ADAPTER_IDS,
  PI_LOOP_ENGINE_REASON,
  ROADMAP_LOOP_ENGINE_REASON,
} from '@/core/settings/adapters.js';

describe('loop engine admission', () => {
  describe('resolveRequestedLoopEngine', () => {
    it('treats an omitted or null value as "use the effective default"', () => {
      expect(resolveRequestedLoopEngine(undefined)).toBeUndefined();
      expect(resolveRequestedLoopEngine(null)).toBeUndefined();
    });

    it('accepts every executable engine id', () => {
      for (const id of EXECUTABLE_LOOP_ENGINE_IDS) {
        expect(resolveRequestedLoopEngine(id)).toBe(id);
      }
    });

    it('rejects roadmap engines with the unsupported code and the descriptor reason', () => {
      for (const id of ['harness', 'codex', 'claude'] as const) {
        try {
          resolveRequestedLoopEngine(id);
          throw new Error(`expected ${id} to be rejected`);
        } catch (error) {
          expect(error).toBeInstanceOf(LoopEngineUnsupportedError);
          const admission = error as LoopEngineUnsupportedError;
          expect(admission.code).toBe(LOOP_ENGINE_UNSUPPORTED_CODE);
          expect(admission.reason).toBe(ROADMAP_LOOP_ENGINE_REASON);
        }
      }
    });

    it('rejects values outside the public contract with the invalid code', () => {
      for (const value of ['nonsense', 'BUILTIN', '', 'gpt-5', 42, true, {}]) {
        try {
          resolveRequestedLoopEngine(value);
          throw new Error(`expected ${String(value)} to be rejected`);
        } catch (error) {
          expect(error).toBeInstanceOf(LoopEngineInvalidError);
          expect((error as LoopEngineInvalidError).code).toBe(LOOP_ENGINE_INVALID_CODE);
        }
      }
    });

    it('never maps an unavailable engine onto builtin', () => {
      expect(() => resolveRequestedLoopEngine('codex')).toThrow();
      expect(resolveRequestedLoopEngine('builtin')).toBe('builtin');
    });
  });

  describe('assertLoopEngineExecutable', () => {
    it('returns quietly when the strategy is registered', () => {
      expect(() => assertLoopEngineExecutable('pi', () => true)).not.toThrow();
    });

    it('reports the Pi restriction instead of hiding it', () => {
      try {
        assertLoopEngineExecutable('pi', () => false);
        throw new Error('expected pi to be rejected');
      } catch (error) {
        expect(error).toBeInstanceOf(LoopEngineUnsupportedError);
        expect((error as LoopEngineUnsupportedError).reason).toBe(PI_LOOP_ENGINE_REASON);
      }
    });

    it('falls back to the generic reason when the descriptor carries none', () => {
      try {
        assertLoopEngineExecutable('builtin', () => false);
        throw new Error('expected builtin to be rejected');
      } catch (error) {
        expect((error as LoopEngineUnsupportedError).reason).toBe(LOOP_ENGINE_NOT_REGISTERED_REASON);
      }
    });
  });

  describe('isLoopEngineAdmissionError', () => {
    it('recognizes both admission error classes', () => {
      expect(isLoopEngineAdmissionError(new LoopEngineInvalidError('x'))).toBe(true);
      expect(isLoopEngineAdmissionError(new LoopEngineUnsupportedError('codex', 'nope'))).toBe(true);
    });

    it('does not claim unrelated errors', () => {
      expect(isLoopEngineAdmissionError(new Error('boom'))).toBe(false);
      expect(isLoopEngineAdmissionError(undefined)).toBe(false);
      expect(isLoopEngineAdmissionError('loop_engine_invalid')).toBe(false);
    });
  });

  it('keeps the public contract and the executable subset consistent', () => {
    expect([...LOOP_ENGINE_ADAPTER_IDS]).toEqual(['builtin', 'pi', 'harness', 'codex', 'claude']);
    for (const id of EXECUTABLE_LOOP_ENGINE_IDS) {
      expect(LOOP_ENGINE_ADAPTER_IDS).toContain(id);
      expect(resolveRequestedLoopEngine(id)).toBe(id);
    }
  });
});
