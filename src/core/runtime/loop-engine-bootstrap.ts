import type { Database } from '@/core/db/database.js';
import { DefaultStrategy } from '@/strategy/default-strategy.js';
import { PiStrategy } from '@/strategy/pi-strategy.js';
import { PiLauncher } from '@/strategy/pi-launcher.js';
import { PiAdapter } from '@/strategy/pi/pi-adapter.js';
import { PiInteractionStore } from '@/strategy/pi/interaction-store.js';
import { PI_APPROVAL_MODE_DEFAULT, piPreauthorizedRuleFor } from '@/strategy/pi/approval-mode.js';
import type { RuntimeSettings } from '@/core/settings/schema.js';
import type { AgentStrategy } from '@/types/strategy.js';
import type { SessionLoopEngine } from '@/types/session.js';

export interface RuntimeLoopEngine {
  /** Strategy selected by the effective global settings for new sessions. */
  strategy: AgentStrategy;
  /** Provider captured when creating a new session. */
  provider: SessionLoopEngine;
  /** Strategies retained so resumed sessions keep their persisted provider. */
  strategies: Partial<Record<SessionLoopEngine, AgentStrategy>>;
  defaultMaxSteps: number;
}

export interface RuntimeLoopEngineBootstrapOptions {
  dataDir?: string;
  database?: Database;
}

export function bootstrapRuntimeLoopEngine(
  settings: RuntimeSettings,
  options: RuntimeLoopEngineBootstrapOptions = {},
): RuntimeLoopEngine {
  const builtin = new DefaultStrategy();
  const strategies: Partial<Record<SessionLoopEngine, AgentStrategy>> = { builtin };
  if (options.dataDir) {
    const timeoutSeconds = settings.loop_engine.options.timeout_seconds;
    const timeoutMs = typeof timeoutSeconds === 'number' && Number.isFinite(timeoutSeconds) && timeoutSeconds > 0
      ? Math.trunc(timeoutSeconds * 1000)
      : undefined;
    const launcher = new PiLauncher({
      dataDir: options.dataDir,
      database: options.database,
      ...(timeoutMs ? { timeoutMs } : {}),
    });
    // Pi is not launched per turn any more: the strategy asks this adapter for
    // one session-owned RPC child, and the adapter is the only place that knows
    // the child's wire protocol. The per-turn deadline and the per-command
    // response deadline are the same setting the print-mode launch used as its
    // process timeout, so a turn that used to time out still does.
    //
    // The pending-interaction store is what makes a gate decision one-shot: the
    // record is consumed by a conditional update, so the store is composed
    // whenever a database exists. Without one the adapter still starts sessions
    // that gate nothing and refuses a launch that declares a gated tool, rather
    // than running that tool with no decision attached.
    const interactions = options.database
      ? new PiInteractionStore(options.database, options.dataDir)
      : undefined;
    // Off unless an operator selected it: an absent or unrecognized mode is
    // resolved to `interactive` here and refused by Settings validation before a
    // row can be saved, so an unattended runtime is always an explicit choice.
    const approvalMode = settings.loop_engine.options.approval_mode ?? PI_APPROVAL_MODE_DEFAULT;
    const preauthorizedRule = piPreauthorizedRuleFor(approvalMode);
    const adapter = new PiAdapter({
      launcher,
      ...(interactions ? { interactions } : {}),
      // Resolved from the *effective* settings, and consulted by the session at
      // every gate rather than latched when one opens: the mode an operator saves
      // applies to the decisions of the runtime that activates it, the next gated
      // call is decided again instead of inheriting a standing permission, and a
      // decision already recorded keeps its recorded source.
      //
      // The rule exists only when an operator selected `preauthorized_once`.
      // Nothing in an interactive runtime can answer a gate on its own, which is
      // what makes the mode an explicit opt-in rather than an implied default.
      approvalMode: () => approvalMode,
      ...(preauthorizedRule ? { preauthorizedRule } : {}),
      ...(timeoutMs ? { turnTimeoutMs: timeoutMs, requestTimeoutMs: timeoutMs } : {}),
    });
    strategies.pi = new PiStrategy({
      adapter,
      database: options.database,
      // The same resolved mode the adapter decides gates with, so the contract a
      // session is bound to is the one this runtime would actually apply.
      approvalMode: () => approvalMode,
    });
  }

  const provider = settings.loop_engine.provider;
  if (provider !== 'builtin' && provider !== 'pi') {
    throw new Error(`Loop engine "${provider}" is not available`);
  }
  const strategy = strategies[provider];
  if (!strategy) {
    throw new Error('Pi loop engine requires runtime data directory and model configuration');
  }
  return {
    strategy,
    provider,
    strategies,
    defaultMaxSteps: settings.loop_engine.options.default_max_steps,
  };
}
