import { describe, expect, it } from 'vitest';
import { PiStrategy } from '@/strategy/pi-strategy.js';
import type { StrategyContext } from '@/types/strategy.js';

describe('PiStrategy', () => {
  it('forwards the composed system, selected model config, and cancellation signal', async () => {
    const launches: unknown[] = [];
    const controller = new AbortController();
    const strategy = new PiStrategy({
      launch: async (request) => { launches.push(request); },
    });
    const context = {
      session: {
        id: 'sess_pi_prompt', agentId: 'agent_test', agentName: 'test', environmentId: 'env_default',
        status: 'running', createdAt: new Date(), updatedAt: new Date(),
      },
      userEvent: { type: 'user.message', content: [{ type: 'text', text: 'Implement this.' }] },
      systemPrompt: '# System\n\n# Skill\nFollow the skill instructions.',
      messages: [],
      modelConfig: {
        name: 'selected', provider: 'openai', model: 'gpt-pi-selected', api_key: '${MODEL_API_KEY}',
      },
      tools: {},
      sandbox: { sessionId: 'sess_pi_prompt', hostWorkDir: '/sandbox/work' },
      eventLog: {},
      broadcast: () => {},
      abortSignal: controller.signal,
      config: {},
    } as unknown as StrategyContext;

    for await (const _event of strategy.execute(context)) {
      // Pi foundation yields no canonical events yet.
    }

    expect(launches).toEqual([{
      sessionId: 'sess_pi_prompt',
      workDir: '/sandbox/work',
      prompt: 'Implement this.',
      systemPrompt: '# System\n\n# Skill\nFollow the skill instructions.',
      model: {
        name: 'selected', provider: 'openai', model: 'gpt-pi-selected', api_key: '${MODEL_API_KEY}',
      },
      abortSignal: controller.signal,
    }]);
  });
});
