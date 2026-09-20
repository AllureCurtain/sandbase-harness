import type { TextBlock } from '@/types/cma-protocol.js';
import type { AgentStrategy, StrategyContext } from '@/types/strategy.js';
import type { PiLaunchRequest, PiProcessHandle } from './pi-launcher.js';
import type { Database } from '@/core/db/database.js';
import {
  getPiSessionState,
  inspectPiSessionFile,
  markPiSessionContinuityFailure,
  recordPiSessionState,
  PiContinuityError,
  PI_RESUME_REFUSED_MARKER,
} from './pi/session-continuity.js';
import { PiCleanupPendingError, PiTimeoutError } from './pi-launcher.js';
import { PiStderrTail } from './pi/stderr-tail.js';
import { PiTranslator } from './pi/translator.js';

export interface PiTurnLauncher {
  /** Foundation compatibility path; adapter-aware launchers also implement start. */
  launch(request: PiLaunchRequest): Promise<void>;
  start?(request: PiLaunchRequest): Promise<PiProcessHandle>;
}

/**
 * Pi print-mode strategy. The foundation's opaque launch() fallback remains
 * available for isolated process tests; the real runtime uses start() so this
 * strategy owns validated JSONL translation and canonical event persistence.
 */
export class PiStrategy implements AgentStrategy {
  readonly name = 'pi';
  /** Pi owns model transport, so the executor must not construct an AI SDK model. */
  readonly requiresModel = false;
  private readonly database?: Database;

  constructor(private readonly launcher: PiTurnLauncher, database?: Database) {
    this.database = database;
  }

  async *execute(context: StrategyContext) {
    if (!context.sandbox.hostWorkDir) {
      throw new Error('Pi loop engine requires a sandbox with a host-accessible work directory');
    }
    if (!context.userEvent || context.userEvent.type !== 'user.message') {
      throw new Error('Pi loop engine foundation supports user.message turns only');
    }
    if (!context.userEvent.content.every((block): block is TextBlock => block.type === 'text')) {
      throw new Error('Pi loop engine foundation supports text user messages only');
    }
    if (!context.modelConfig) {
      throw new Error('Pi loop engine requires a selected model configuration');
    }

    const selectedModel = context.modelConfig.model;
    if (!selectedModel) {
      throw new Error('Pi loop engine requires a selected model id');
    }
    const request: PiLaunchRequest = {
      sessionId: context.session.id,
      workDir: context.sandbox.hostWorkDir,
      prompt: context.userEvent.content.map((block) => block.text).join('\n'),
      systemPrompt: context.systemPrompt,
      model: context.modelConfig,
      ...(context.skillDirs?.length ? { skillDirs: context.skillDirs } : {}),
      ...(thinkingLevelForSpeed(context.session.agentDefinition?.model_config?.speed)
        ? { thinkingLevel: thinkingLevelForSpeed(context.session.agentDefinition?.model_config?.speed) }
        : {}),
      ...(context.abortSignal ? { abortSignal: context.abortSignal } : {}),
    };

    // Keep the foundation behavior for a launcher test double that has not yet
    // opted into stdout consumption. No canonical event is fabricated here.
    if (!this.launcher.start) {
      await this.launcher.launch(request);
      return;
    }

    const handle = await this.launcher.start(request);
    if (!handle.stdout) throw new Error('Pi process did not expose stdout for JSONL adapter');
    if (!handle.stderr) throw new Error('Pi process did not expose stderr for diagnostics');

    const stderr = new PiStderrTail();
    const stderrDrain = drainStderr(handle.stderr, stderr);
    const translator = new PiTranslator({
      sessionId: context.session.id,
      model: selectedModel,
      eventLog: context.eventLog,
      broadcast: context.broadcast,
      recordUsage: (sessionId, inputTokens, outputTokens) => {
        context.eventLog.recordUsage(sessionId, inputTokens, outputTokens);
      },
    });

    let parserFinished = false;
    try {
      const parsePromise = translator.consume(handle.stdout);
      const exit = await Promise.all([parsePromise, handle.wait()]).then(([, result]) => result);
      parserFinished = true;
      const summary = translator.finish();
      await stderrDrain;

      if (!summary.sawSessionHeader) {
        throw new Error('Pi stdout ended without a session header');
      }
      if (exit.code !== 0 || exit.signal) {
        throw new Error(withStderr(
          `Pi process exited with code ${exit.code ?? 'unknown'}${exit.signal ? ` (${exit.signal})` : ''}`,
          stderr.text(),
        ));
      }
      if (summary.lastTurnError) {
        throw new Error(withStderr(summary.lastTurnError, stderr.text()));
      }

      if (this.database && handle.sessionFile) {
        const header = inspectPiSessionFile(handle.sessionFile);
        if (!header) {
          throw new PiContinuityError('pi_session_discontinuous', 'Pi completed without writing a session header');
        }
        const previous = getPiSessionState(this.database, context.session.id);
        if (previous && (previous.piSessionId !== header.id || previous.schemaVersion !== header.schemaVersion)) {
          throw new PiContinuityError('pi_session_discontinuous', 'Pi changed its session identity or schema during the turn');
        }
        recordPiSessionState(this.database, context.session.id, handle.sessionFile, header);
        if (handle.leaseRecovered) {
          const notice = context.eventLog.append(context.session.id, {
            type: 'agent.message',
            content: [{ type: 'text', text: 'Pi continuity notice: recovered a stale session-file lease before this turn.' }],
          });
          context.broadcast(notice);
        }
      }

      // `turn_complete` is the durable adapter terminal marker. It is appended
      // before strategy completion and never yielded separately.
      const terminal = context.eventLog.append(context.session.id, { type: 'turn_complete' });
      context.broadcast(terminal);
    } catch (error) {
      if (!parserFinished && error instanceof Error && error.name !== 'AbortError') {
        await handle.terminate(true).catch(() => {});
        await handle.wait().catch(() => {});
      }
      await stderrDrain.catch(() => {});
      if (error instanceof Error && error.name === 'AbortError') throw error;
      if (error instanceof PiCleanupPendingError || error instanceof PiTimeoutError || error instanceof PiContinuityError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      if (this.database && handle.sessionFile && stderr.text().includes(PI_RESUME_REFUSED_MARKER)) {
        const refusal = new PiContinuityError('pi_resume_refused', `Pi refused to resume its managed session: ${stderr.text()}`);
        markPiSessionContinuityFailure(this.database, context.session.id, handle.sessionFile, refusal.code, refusal.message);
        throw refusal;
      }
      throw new Error(withStderr(message, stderr.text()));
    }
  }
}

function thinkingLevelForSpeed(speed: string | undefined): PiLaunchRequest['thinkingLevel'] {
  switch (speed) {
    case 'fast': return 'off';
    case 'extended': return 'high';
    case 'standard': return 'medium';
    default: return undefined;
  }
}

async function drainStderr(stream: AsyncIterable<Uint8Array | string>, tail: PiStderrTail): Promise<void> {
  for await (const chunk of stream) tail.append(chunk);
}

function withStderr(message: string, tail: string): string {
  return tail ? `${message}; Pi stderr: ${tail}` : message;
}
