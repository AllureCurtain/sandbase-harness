import { describe, expect, it } from 'vitest';
import { bootstrapRuntimeLoopEngine } from '@/core/runtime/loop-engine-bootstrap.js';
import { piPreauthorizedRuleFor } from '@/strategy/pi/approval-mode.js';
import type { PiInteractionRecord } from '@/strategy/pi/interaction-store.js';

const settings = {
  schema_version: 1,
  model: { vendor: 'openai', api_key: '${OPENAI_API_KEY}', options: {} },
  loop_engine: { provider: 'builtin', options: { default_max_steps: 42 } },
  storage: {
    metadata: { provider: 'sqlite', options: {} },
    artifacts: { provider: 'local', options: { base_path: 'files' } },
  },
  memory: { enabled: true, provider: 'sqlite', options: {} },
  sandbox: { provider: 'local', options: { timeout_seconds: 300 } },
} as const;

/** The one thing a platform rule is asked about: the call it may answer. */
const interactionRecord: PiInteractionRecord = {
  id: 'pint_fixture',
  sessionId: 'sess_fixture',
  turnId: 'piturn_1',
  piRequestId: 'ui-gate-1',
  toolUseId: 'toolu_1',
  toolName: 'bash',
  originalInput: { command: 'echo hello' },
  inputFingerprint: 'fixture-fingerprint',
  state: 'pending',
};

describe('runtime loop engine bootstrap', () => {
  it('creates the built-in strategy and exposes configured max steps', () => {
    const engine = bootstrapRuntimeLoopEngine(settings);

    expect(engine.defaultMaxSteps).toBe(42);
    expect(engine.strategy.execute).toBeTypeOf('function');
  });

  it('creates the Pi strategy when runtime data are available', () => {
    const engine = bootstrapRuntimeLoopEngine({
      ...settings,
      loop_engine: { provider: 'pi', options: { default_max_steps: 25 } },
    }, {
      dataDir: '/runtime-data',
    });

    expect(engine.provider).toBe('pi');
    expect(engine.strategy.name).toBe('pi');
    expect(engine.strategies.builtin?.name).toBe('default');
    expect(engine.strategies.pi?.name).toBe('pi');
  });

  it('composes the unattended Pi gate rule only when the approval mode selected it', () => {
    const engine = bootstrapRuntimeLoopEngine({
      ...settings,
      loop_engine: {
        provider: 'pi',
        options: { default_max_steps: 25, approval_mode: 'preauthorized_once' },
      },
    }, {
      dataDir: '/runtime-data',
    });
    expect(engine.provider).toBe('pi');

    // Selecting the mode is the preauthorization authority: the rule exists, it
    // allows exactly the call it is asked about, and the gate still records that
    // answer as the platform's rather than a person's (the record path is
    // asserted in the RPC session and adapter gate tests).
    const rule = piPreauthorizedRuleFor('preauthorized_once');
    expect(rule).toBeTypeOf('function');
    expect(rule?.(interactionRecord)).toEqual({ allow: true });

    // Without the mode there is nothing that could answer a gate on its own.
    expect(piPreauthorizedRuleFor('interactive')).toBeUndefined();
  });

  it('rejects unavailable loop engines', () => {
    expect(() => bootstrapRuntimeLoopEngine({
      ...settings,
      loop_engine: { provider: 'codex', options: { default_max_steps: 25 } },
    })).toThrow(/not available/);
  });
});
