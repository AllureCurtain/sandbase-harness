import type { Database } from '@/core/db/database.js';
import { DefaultStrategy } from '@/strategy/default-strategy.js';
import { PiStrategy } from '@/strategy/pi-strategy.js';
import { PiLauncher } from '@/strategy/pi-launcher.js';
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
    strategies.pi = new PiStrategy(launcher, options.database);
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
