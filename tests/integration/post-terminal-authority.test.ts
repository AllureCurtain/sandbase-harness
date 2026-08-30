/**
 * prefix-safe-json 0.4.3 (GHSA-3xpw-9694-2xxp) regression coverage for this
 * integration specifically.
 *
 * 0.4.3 fixes three root causes in prefix-safe-json's AI SDK adapter/gate:
 *   1. the adapter used to silently drop every raw event once it had
 *      already observed a terminal, so genuinely late/contradictory
 *      evidence within the same stream never reached the coordinator at
 *      all;
 *   2. `takeDecision()` used to read a decision snapshot frozen at
 *      `finish()` time instead of the coordinator's live diagnostics, so
 *      evidence recorded *after* `finish()` but *before* that call's
 *      authority was consumed was never consulted;
 *   3. a raw event carrying conflicting `id`/`toolCallId` used to silently
 *      prefer `id` instead of failing the stream closed.
 *
 * `default-strategy.ts`'s actual consumption pattern (`for await` drains
 * the *entire* multi-step `fullStream`, `guard.finish()` is called once
 * immediately after, then every `guard.takeDecision()` call for
 * `pendingConfirmationCalls` happens synchronously in the same tick, with
 * no `await` in between) means root cause #2's literal finish()-to-
 * takeDecision() async gap does not open here — there is no point where
 * new evidence could be pushed between this integration's own `finish()`
 * call and its own decision consumption. What *is* live is root cause #1:
 * whether a late/contradicting raw event arriving anywhere in the
 * (potentially multi-step) `fullStream`, before `guard.finish()` is ever
 * called, correctly revokes authority instead of being silently dropped by
 * the adapter. Section A proves that directly through this repo's real
 * `createAiSdkV4ExecutionGuard` (the exact wrapper `default-strategy.ts`
 * uses), fed the real AI SDK v4 wire part names it translates. Section B
 * exercises the raw `prefix-safe-json` library's `takeDecision()` directly
 * against the literal GHSA-3xpw-9694-2xxp repro shape (the one this
 * integration's own architecture avoids by construction, per above),
 * confirming the library-level guarantee the dependency bump pulls in is
 * genuinely present, in case this integration's consumption pattern ever
 * changes to introduce that gap.
 */
import { describe, expect, it } from 'vitest';
import { createAiSdkV4ExecutionGuard } from '@/strategy/ai-sdk-v4-execution-guard.js';
import { createAiSdkExecutionGuard } from 'prefix-safe-json';

describe('prefix-safe-json 0.4.3 — post-terminal / stale-authority fix, exercised through this integration', () => {
  describe('Section A: createAiSdkV4ExecutionGuard (the real ai-sdk-v4-execution-guard.ts wrapper default-strategy.ts uses)', () => {
    it('a late tool-result for an already-clean call revokes authority instead of being silently dropped', () => {
      const guard = createAiSdkV4ExecutionGuard();
      const toolCallId = 'call_write_1';

      // A tool call that looks completely safe on its own, in AI SDK v4's
      // own wire part names (tool-call-streaming-start / tool-call-delta /
      // tool-call), exactly what default-strategy.ts's fullStream loop
      // hands to guard.push().
      guard.push({ type: 'tool-call-streaming-start', toolCallId, toolName: 'write' });
      guard.push({ type: 'tool-call-delta', toolCallId, argsTextDelta: '{"path":"a.txt","content":"safe"}' });
      guard.push({ type: 'tool-call', toolCallId, toolName: 'write', args: '{"path":"a.txt","content":"safe"}' });
      guard.push({ type: 'finish', finishReason: 'tool-calls' });

      // ...followed, still within the same fullStream, before finish() is
      // called, by evidence that the SDK actually executed this call
      // itself / the surrounding step did not actually end cleanly. Before
      // 0.4.3, the adapter's own "already finished" early return silently
      // dropped this — the coordinator never saw it, and the decision
      // stayed "execute".
      guard.push({ type: 'tool-result', toolCallId, toolName: 'write', result: { ranUpstream: true } });

      const final = guard.finish();
      const decision = final.decisions.find((d) => d.toolCallId === toolCallId);
      expect(decision).toBeDefined();
      expect(decision!.action).not.toBe('execute');

      const authority = guard.takeDecision(decision!.internalId);
      expect(authority).toBeUndefined();
    });

    it('control: the same sequence with no late evidence still executes exactly once (the fix above does not overcorrect)', () => {
      const guard = createAiSdkV4ExecutionGuard();
      const toolCallId = 'call_write_2';

      guard.push({ type: 'tool-call-streaming-start', toolCallId, toolName: 'write' });
      guard.push({ type: 'tool-call-delta', toolCallId, argsTextDelta: '{"path":"a.txt","content":"safe"}' });
      guard.push({ type: 'tool-call', toolCallId, toolName: 'write', args: '{"path":"a.txt","content":"safe"}' });
      guard.push({ type: 'finish', finishReason: 'tool-calls' });

      const final = guard.finish();
      const decision = final.decisions.find((d) => d.toolCallId === toolCallId);
      expect(decision?.action).toBe('execute');

      const authority = guard.takeDecision(decision!.internalId);
      expect(authority).toBeDefined();
      expect(authority?.action).toBe('execute');

      const second = guard.takeDecision(decision!.internalId);
      expect(second).toBeUndefined();
    });
  });

  describe('Section B: the raw prefix-safe-json library (createAiSdkExecutionGuard directly) — the literal GHSA-3xpw-9694-2xxp repro shape', () => {
    it('evidence arriving after finish() but before takeDecision() revokes authority (library-level proof this dependency bump actually pulls in)', () => {
      const guard = createAiSdkExecutionGuard();
      const id = 'call_1';

      guard.push({ type: 'tool-input-start', id, toolName: 'write' });
      guard.push({ type: 'tool-input-delta', id, delta: '{"path":"a.txt","content":"safe"}' });
      guard.push({ type: 'tool-input-end', id });
      guard.push({ type: 'finish', finishReason: 'tool-calls' });

      const final = guard.finish();
      const decision = final.decisions.find((d) => d.toolCallId === id);
      expect(decision).toBeDefined();
      expect(decision!.action).toBe('execute');

      // Late evidence, after finish() was already called, before this
      // call's authority is consumed via takeDecision() — the exact
      // GHSA-3xpw-9694-2xxp window. default-strategy.ts's own synchronous
      // consumption pattern avoids ever opening this window (see file
      // header), but the underlying library guarantee still needs to
      // hold on its own merits.
      guard.push({ type: 'tool-result', toolCallId: id, toolName: 'write', result: { ranUpstream: true } });

      const authority = guard.takeDecision(decision!.internalId);
      expect(authority).toBeUndefined();
    });
  });
});
