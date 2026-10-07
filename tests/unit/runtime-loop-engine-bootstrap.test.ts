import { describe, expect, it } from 'vitest';
import { bootstrapRuntimeLoopEngine } from '@/core/runtime/loop-engine-bootstrap.js';
import { CANONICAL_TOOL_RESULT_MAX_CHARS } from '@/core/session/tool-output-overflow.js';
import type { RuntimeSettings } from '@/core/settings/schema.js';
import { piPreauthorizedRuleFor } from '@/strategy/pi/approval-mode.js';
import type { PiInteractionRecord } from '@/strategy/pi/interaction-store.js';

const settings = {
  schema_version: 1,
  model: { vendor: 'openai', api_key: '${OPENAI_API_KEY}', options: {} },
  loop_engine: { provider: 'builtin', options: { default_max_steps: 42, tool_result_max_chars: 42_000 } },
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

  it('exposes the configured tool-result overflow threshold', () => {
    const engine = bootstrapRuntimeLoopEngine(settings);
    expect(engine.toolResultMaxChars).toBe(42_000);
  });

  it('falls back to the published threshold when a fixture omits the option', () => {
    const engine = bootstrapRuntimeLoopEngine({
      ...settings,
      loop_engine: {
        provider: 'builtin',
        // A pre-option settings row still parses; the bootstrap resolves the
        // published default rather than handing the strategy `undefined`.
        options: { default_max_steps: 42 } as RuntimeSettings['loop_engine']['options'],
      },
    });
    expect(engine.toolResultMaxChars).toBe(CANONICAL_TOOL_RESULT_MAX_CHARS);
  });

  it('creates the Pi strategy when runtime data are available', () => {
    const engine = bootstrapRuntimeLoopEngine({
      ...settings,
      loop_engine: { provider: 'pi', options: { default_max_steps: 25, tool_result_max_chars: 42_000 } },
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
        options: { default_max_steps: 25, approval_mode: 'preauthorized_once', tool_result_max_chars: 42_000 },
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
      loop_engine: { provider: 'codex', options: { default_max_steps: 25, tool_result_max_chars: 42_000 } },
    })).toThrow(/not available/);
  });
});
