/**
 * Anthropic model options: the capability table, the `providerOptions`
 * builder, and the admission rules that keep an option a known model cannot
 * take from being stored and silently dropped.
 */

import { describe, expect, it } from 'vitest';
import { anthropicModelCapabilities } from '@/model/anthropic-capabilities.js';
import { anthropicCallOptions } from '@/model/anthropic-options.js';
import { normalizeModelField } from '@/core/agent/model-object.js';
import { validateAgentDefinition } from '@/core/agent/schema.js';

describe('anthropicModelCapabilities', () => {
  it('returns capabilities for a documented model', () => {
    const caps = anthropicModelCapabilities('claude-opus-5');
    expect(caps?.adaptiveThinking).toBe(true);
    expect(caps?.fastMode).toBe(true);
    expect(caps?.effortLevels).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('resolves dated ids to their family', () => {
    expect(anthropicModelCapabilities('claude-opus-4-8-20251001')?.fastMode).toBe(true);
    expect(anthropicModelCapabilities('claude-sonnet-4-6-20251001')?.adaptiveThinking).toBe(true);
  });

  it('keeps a generic family prefix from shadowing a specific one', () => {
    // `claude-opus-4` must not decide for `claude-opus-4-8`.
    expect(anthropicModelCapabilities('claude-opus-4-8')?.fastMode).toBe(true);
    expect(anthropicModelCapabilities('claude-opus-4-7')?.fastMode).toBe(false);
    expect(anthropicModelCapabilities('claude-opus-4')?.effortLevels).toEqual([]);
  });

  it('records the published per-level effort differences', () => {
    // Opus 4.6 takes `max` but not `xhigh`; Opus 4.5 tops out at `high`;
    // Haiku 4.5 takes no effort at all.
    expect(anthropicModelCapabilities('claude-opus-4-6')?.effortLevels).toEqual(['low', 'medium', 'high', 'max']);
    expect(anthropicModelCapabilities('claude-sonnet-4-6')?.effortLevels).toEqual(['low', 'medium', 'high', 'max']);
    expect(anthropicModelCapabilities('claude-opus-4-5')?.effortLevels).toEqual(['low', 'medium', 'high']);
    expect(anthropicModelCapabilities('claude-haiku-4-5')?.effortLevels).toEqual([]);
    expect(anthropicModelCapabilities('claude-haiku-4-5')?.adaptiveThinking).toBe(false);
  });

  it('returns undefined for a model the table does not know', () => {
    expect(anthropicModelCapabilities('claude-next-9')).toBeUndefined();
    expect(anthropicModelCapabilities('gpt-5')).toBeUndefined();
    expect(anthropicModelCapabilities('deepseek-chat')).toBeUndefined();
  });
});

describe('anthropicCallOptions', () => {
  it('sends effort, adaptive thinking, and fast speed on a capable model', () => {
    expect(anthropicCallOptions({ modelId: 'claude-opus-5', effort: 'high', speed: 'fast' })).toEqual({
      anthropic: {
        thinking: { type: 'adaptive', display: 'omitted' },
        effort: 'high',
        speed: 'fast',
      },
    });
  });

  it('sends adaptive thinking without effort or speed when neither is configured', () => {
    expect(anthropicCallOptions({ modelId: 'claude-sonnet-4-6' })).toEqual({
      anthropic: { thinking: { type: 'adaptive', display: 'omitted' } },
    });
  });

  it('omits speed "standard" — the provider default needs no field', () => {
    expect(anthropicCallOptions({ modelId: 'claude-opus-5', speed: 'standard' })).toEqual({
      anthropic: { thinking: { type: 'adaptive', display: 'omitted' } },
    });
  });

  it('omits the local "extended" speed — it has no wire form', () => {
    const options = anthropicCallOptions({ modelId: 'claude-opus-5', speed: 'extended' });
    expect(options?.anthropic.speed).toBeUndefined();
  });

  it('sends thinking but no fast speed on a capable model without fast mode', () => {
    expect(anthropicCallOptions({ modelId: 'claude-sonnet-5', speed: 'fast' })).toEqual({
      anthropic: { thinking: { type: 'adaptive', display: 'omitted' } },
    });
  });

  it('returns undefined for a model the capability table does not cover', () => {
    expect(anthropicCallOptions({ modelId: 'claude-next-9', effort: 'high', speed: 'fast' })).toBeUndefined();
  });
});

describe('normalizeModelField — capability checks', () => {
  it('refuses fast speed on a model fast mode does not cover', () => {
    for (const id of ['claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-5', 'claude-haiku-4-5']) {
      const result = normalizeModelField({ id, speed: 'fast' });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('unsupported_model_speed');
      expect(result.field).toBe('speed');
    }
  });

  it('accepts fast speed on the published fast-mode models', () => {
    for (const id of ['claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8']) {
      const result = normalizeModelField({ id, speed: 'fast' });
      expect(result.ok).toBe(true);
    }
  });

  it('refuses an effort level the selected model does not list', () => {
    const xhighOnSonnet46 = normalizeModelField({ id: 'claude-sonnet-4-6', effort: 'xhigh' });
    expect(xhighOnSonnet46.ok).toBe(false);
    expect(xhighOnSonnet46.code).toBe('unsupported_model_effort');
    expect(xhighOnSonnet46.message).toContain('low, medium, high, max');

    const maxOnOpus45 = normalizeModelField({ id: 'claude-opus-4-5', effort: 'max' });
    expect(maxOnOpus45.ok).toBe(false);
    expect(maxOnOpus45.code).toBe('unsupported_model_effort');
  });

  it('refuses any effort on a model that takes none', () => {
    const result = normalizeModelField({ id: 'claude-haiku-4-5', effort: 'low' });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('unsupported_model_effort');
    expect(result.field).toBe('effort');
  });

  it('accepts options on a model the table does not know — unknown is not incapable', () => {
    const result = normalizeModelField({ id: 'claude-next-9', speed: 'fast', effort: 'xhigh' });
    expect(result.ok).toBe(true);
  });

  it('accepts non-Anthropic model ids without consulting the table', () => {
    const result = normalizeModelField({ id: 'deepseek-chat', speed: 'fast', effort: 'low' });
    expect(result.ok).toBe(true);
  });
});

describe('validateAgentDefinition — model_config capability check', () => {
  const base = { name: 'Model Agent', system: 'You are terse.' };

  it('refuses fast speed through the model_config spelling too', () => {
    const result = validateAgentDefinition({
      ...base,
      model: 'claude-sonnet-4-6',
      model_config: { id: 'claude-sonnet-4-6', speed: 'fast' },
    });
    expect(result.valid).toBe(false);
    expect(result.errors?.[0]?.path).toBe('model_config.speed');
  });

  it('refuses an unsupported effort level through model_config', () => {
    const result = validateAgentDefinition({
      ...base,
      model: 'claude-sonnet-4-6',
      model_config: { id: 'claude-sonnet-4-6', speed: 'standard', effort: 'xhigh' },
    });
    expect(result.valid).toBe(false);
    expect(result.errors?.[0]?.path).toBe('model_config.effort');
    expect(result.errors?.[0]?.message).toContain('xhigh');
  });

  it('checks model_config against its own id when it overrides the model reference', () => {
    // model_config.id names a different model: that id decides capability.
    const result = validateAgentDefinition({
      ...base,
      model: 'claude-opus-5',
      model_config: { id: 'claude-sonnet-4-6', speed: 'fast' },
    });
    expect(result.valid).toBe(false);
  });

  it('passes a capable model_config unchanged', () => {
    const result = validateAgentDefinition({
      ...base,
      model: 'claude-opus-5',
      model_config: { id: 'claude-opus-5', speed: 'fast', effort: 'xhigh' },
    });
    expect(result.valid).toBe(true);
    expect(result.data?.model_config).toEqual({ id: 'claude-opus-5', speed: 'fast', effort: 'xhigh' });
  });
});
