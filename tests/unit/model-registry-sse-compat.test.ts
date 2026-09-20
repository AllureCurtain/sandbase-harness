/**
 * Unit tests for the OpenAI-compatible SSE compatibility layer.
 *
 * Regression: some OpenAI-compatible gateways fragment a single tool call
 * across many SSE deltas and emit `type: ""` (or omit `type`) on most of
 * them. The AI SDK validates every chunk against the OpenAI wire schema,
 * so the first empty `type` aborted the stream and terminated the session
 * with "Type validation failed".
 *
 * Validates: sanitizeSseLine rewrites only the tool-call type field and
 * leaves argument fragments (split across deltas) byte-for-byte intact.
 */

import { describe, it, expect } from 'vitest';
import { sanitizeSseLine, createSseCompatFetch } from '@/model/registry.js';

function toolCallDelta(fn: Record<string, unknown>, opts: { id?: string; type?: string } = {}) {
  return {
    choices: [{
      delta: { tool_calls: [{ function: fn, id: opts.id ?? '', index: 0, type: opts.type ?? '' }] },
      finish_reason: null,
      index: 0,
    }],
  };
}

describe('OpenAI SSE compatibility layer', () => {
  describe('sanitizeSseLine', () => {
    it('rewrites empty tool-call type to "function" and preserves argument fragments', () => {
      const line = 'data: ' + JSON.stringify(toolCallDelta({ name: '', arguments: '{"' })) + '\n';
      const out = sanitizeSseLine(line);
      const parsed = JSON.parse(out.slice(5).trim());
      const tc = parsed.choices[0].delta.tool_calls[0];
      expect(tc.type).toBe('function');
      expect(tc.function.arguments).toBe('{"');
      expect(out.endsWith('\n')).toBe(true);
    });

    it('rewrites a missing tool-call type to "function"', () => {
      const line = 'data: ' + JSON.stringify({
        choices: [{ delta: { tool_calls: [{ function: { name: 'write_file', arguments: 'x' }, id: 'call_1', index: 0 }] }, index: 0 }],
      }) + '\n';
      const parsed = JSON.parse(sanitizeSseLine(line).slice(5).trim());
      expect(parsed.choices[0].delta.tool_calls[0].type).toBe('function');
    });

    it('passes compliant tool-call chunks through byte-for-byte', () => {
      const line = 'data: ' + JSON.stringify(toolCallDelta({ name: 'write_file', arguments: '{"path":' }, { id: 'call_1', type: 'function' })) + '\n';
      expect(sanitizeSseLine(line)).toBe(line);
    });

    it('leaves non-tool-call chunks (text, usage, [DONE]) untouched', () => {
      const textLine = 'data: {"choices":[{"delta":{"content":"hi"},"index":0}]}\n\n';
      expect(sanitizeSseLine(textLine)).toBe(textLine);
      expect(sanitizeSseLine('data: [DONE]\n\n')).toBe('data: [DONE]\n\n');
    });

    it('passes unparseable lines through unchanged', () => {
      const line = 'data: not-json\n';
      expect(sanitizeSseLine(line)).toBe(line);
    });

    it('reassembles a fragmented relay tool call into valid arguments', () => {
      // Mirrors the observed relay behavior: fragment start carries `{"` with
      // empty name/type; a later delta carries name/id; fragments concatenate
      // to a valid JSON arguments object.
      const fragments = [
        toolCallDelta({ name: '', arguments: '{"' }),
        toolCallDelta({ name: 'write_file', arguments: 'path":"hello.txt","content":"hello world"' }, { id: 'call_1' }),
        toolCallDelta({ name: '', arguments: '}' }),
      ];
      let args = '', name = '', sawBadType = false;
      for (const delta of fragments) {
        const out = sanitizeSseLine('data: ' + JSON.stringify(delta) + '\n');
        const tc = JSON.parse(out.slice(5).trim()).choices[0].delta.tool_calls[0];
        if (tc.type !== 'function') sawBadType = true;
        if (tc.function.name) name ||= tc.function.name;
        args += tc.function.arguments;
      }
      expect(sawBadType).toBe(false);
      expect(name).toBe('write_file');
      expect(JSON.parse(args)).toEqual({ path: 'hello.txt', content: 'hello world' });
    });
  });

  describe('createSseCompatFetch', () => {
    it('sanitizes tool-call chunks from an SSE response', async () => {
      const brokenStream = new ReadableStream<Uint8Array>({
        start(controller) {
          const enc = new TextEncoder();
          controller.enqueue(enc.encode('data: ' + JSON.stringify(toolCallDelta({ name: '', arguments: '{"' })) + '\n\n'));
          controller.enqueue(enc.encode('data: [DONE]\n\n'));
          controller.close();
        },
      });
      const fakeFetch: typeof fetch = async () => new Response(brokenStream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
      const response = await createSseCompatFetch(fakeFetch)('https://relay.example/v1/chat/completions', { method: 'POST' });
      const text = await response.text();
      const chunkLine = text.split('\n').find((l) => l.includes('tool_calls'));
      const tc = JSON.parse(chunkLine!.slice(5).trim()).choices[0].delta.tool_calls[0];
      expect(tc.type).toBe('function');
      expect(tc.function.arguments).toBe('{"');
      expect(text).toContain('[DONE]');
    });

    it('does not wrap non-SSE responses', async () => {
      const fakeFetch: typeof fetch = async () => new Response('{"ok":true}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
      const response = await createSseCompatFetch(fakeFetch)('https://relay.example/v1/models');
      expect(await response.json()).toEqual({ ok: true });
    });
  });
});
