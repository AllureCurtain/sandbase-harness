import type { TextBlock } from '@/types/cma-protocol.js';
import type { AgentStrategy, StrategyContext } from '@/types/strategy.js';
import type { PiLaunchRequest } from './pi-launcher.js';

export interface PiTurnLauncher {
  launch(request: PiLaunchRequest): Promise<void>;
}

/**
 * Minimal Pi print-mode bridge. Pi output remains opaque in this foundation:
 * event translation, tool calls, confirmations, resume continuity, and usage
 * accounting are intentionally not implemented here.
 */
export class PiStrategy implements AgentStrategy {
  readonly name = 'pi';
  /** Pi owns model transport, so the executor must not construct an AI SDK model. */
  readonly requiresModel = false;

  constructor(private readonly launcher: PiTurnLauncher) {}

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

    const prompt = context.userEvent.content
      .map((block) => block.text)
      .join('\n');
    await this.launcher.launch({
      sessionId: context.session.id,
      workDir: context.sandbox.hostWorkDir,
      prompt,
      systemPrompt: context.systemPrompt,
      model: context.modelConfig,
      ...(context.abortSignal ? { abortSignal: context.abortSignal } : {}),
    });
  }
}
