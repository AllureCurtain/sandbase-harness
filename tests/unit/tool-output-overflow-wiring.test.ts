/**
 * Tool output overflow — runtime wiring.
 *
 * `tool-output-overflow.test.ts` proves the spill function behaves. It cannot
 * prove anything calls it: the strategies could each slice output inline and that
 * unit test would still pass. These tests pin the wiring itself, because "one
 * truncation format for every tool" is a property of the call sites, not of the
 * helper.
 *
 * The sources are the built-in tool path (`default-strategy.ts`, which also emits
 * the MCP result event from the same loop body) and the Pi stdout translator
 * (`pi/translator.ts`).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TOOL_OVERFLOW_MARKER } from '@/core/session/tool-output-overflow.js';

const ROOT = process.cwd();
const read = (relative: string) => readFileSync(join(ROOT, relative), 'utf8');

describe('shared spill call sites', () => {
  it('routes the built-in and MCP tool results through one spill call', () => {
    const source = read('src/strategy/default-strategy.ts');

    // Both event kinds are emitted from the same loop body after the same
    // `spillToolOutput` call, so an MCP result cannot get a different truncation
    // treatment than a built-in one.
    expect(source).toContain('spillToolOutput');
    expect(source).toContain("'agent.mcp_tool_result'");
    expect(source).toContain("'agent.tool_result'");

    const spillIndex = source.indexOf('await spillToolOutput(');
    const mcpIndex = source.indexOf("'agent.mcp_tool_result'");
    expect(spillIndex).toBeGreaterThan(-1);
    expect(mcpIndex).toBeGreaterThan(spillIndex);
    // The strategy must not slice tool output on its own; the only truncation
    // authority is the spill module.
    expect(source).not.toContain('.slice(0, TOOL_');
    expect(source).not.toContain('[truncated:');
  });

  it('routes Pi tool results through the same spill call', () => {
    const source = read('src/strategy/pi/translator.ts');

    // The translator is a pure stdout reader, so the contract is injected rather
    // than imported, and the call site awaits it.
    expect(source).toContain('spillToolOutput: (output: string) => Promise<string>');
    expect(source).toContain('await this.options.spillToolOutput(');
    expect(source).not.toContain(TOOL_OVERFLOW_MARKER);
    expect(source).not.toContain('[truncated:');
  });

  it('declares exactly one overflow marker in the codebase', () => {
    // A second marker literal is how "different truncation format per tool"
    // reappears: a caller that builds its own marker is not using the contract.
    const markerLiteral = `'${TOOL_OVERFLOW_MARKER}'`;
    const overflow = read('src/core/session/tool-output-overflow.ts');
    const defaultStrategy = read('src/strategy/default-strategy.ts');
    const piTranslator = read('src/strategy/pi/translator.ts');

    expect(overflow).toContain(markerLiteral);
    expect(defaultStrategy).not.toContain(markerLiteral);
    expect(piTranslator).not.toContain(markerLiteral);
  });

  it('records the overflow path only when a file was actually written', () => {
    const source = read('src/strategy/default-strategy.ts');

    // The metadata is guarded by `overflow.file`, so a sandbox that could not be
    // written does not hand the model a path that does not exist.
    expect(source).toContain('...(overflow.file');
    expect(source).toContain('tool_output_overflow: overflow.file');
  });
});
