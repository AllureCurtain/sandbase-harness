/**
 * Tool output overflow contract.
 *
 * The published contract says an oversized tool result is written into the
 * sandbox and the model keeps a preview plus the path back to the full text.
 * The local ceiling is smaller, so what actually needs testing is the shape of
 * the spill: one marker, a real path only when a file was really written, and
 * the same preview no matter which strategy produced the bytes.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  CANONICAL_TOOL_RESULT_MAX_CHARS,
  LOCAL_TOOL_RESULT_MAX_CHARS,
  TOOL_OVERFLOW_MARKER,
  TOOL_OUTPUT_DIR,
  exceedsToolOutputLimit,
  overflowPreview,
  spillToolOutput,
} from '@/core/session/tool-output-overflow.js';
import type { SandboxInstance } from '@/types/sandbox.js';

function fakeSandbox(overrides: Partial<SandboxInstance> = {}) {
  const writeFile = vi.fn(async () => {});
  const sandbox = {
    sessionId: 'sess_overflow',
    execute: vi.fn(),
    writeFile,
    readFile: vi.fn(),
    listFiles: vi.fn(),
    cleanup: vi.fn(),
    ...overrides,
  } as unknown as SandboxInstance;
  return { sandbox, writeFile };
}

describe('overflow threshold', () => {
  it('keeps the published threshold as a separate reference constant', () => {
    expect(CANONICAL_TOOL_RESULT_MAX_CHARS).toBe(100_000);
    // The local profile must stay strictly smaller, or the honest `partial`
    // capability status would be a lie.
    expect(LOCAL_TOOL_RESULT_MAX_CHARS).toBeLessThan(CANONICAL_TOOL_RESULT_MAX_CHARS);
  });

  it('does not treat a result at the limit as overflow', () => {
    const atLimit = 'x'.repeat(LOCAL_TOOL_RESULT_MAX_CHARS);
    expect(exceedsToolOutputLimit(atLimit)).toBe(false);
    expect(exceedsToolOutputLimit(atLimit + 'x')).toBe(true);
  });

  it('honours a caller-supplied limit', () => {
    expect(exceedsToolOutputLimit('abcd', 4)).toBe(false);
    expect(exceedsToolOutputLimit('abcde', 4)).toBe(true);
  });
});

describe('spillToolOutput', () => {
  it('passes a small result through untouched and writes nothing', async () => {
    const { sandbox, writeFile } = fakeSandbox();
    const result = await spillToolOutput('small output', { sessionId: 'sess_1', sandbox });

    expect(result.preview).toBe('small output');
    expect(result.file).toBeUndefined();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('writes the full output to the sandbox and reports that path', async () => {
    const { sandbox, writeFile } = fakeSandbox();
    const output = 'y'.repeat(LOCAL_TOOL_RESULT_MAX_CHARS + 500);
    const result = await spillToolOutput(output, { sessionId: 'sess_1', sandbox });

    expect(writeFile).toHaveBeenCalledTimes(1);
    const [writtenPath, writtenContent] = writeFile.mock.calls[0] as unknown as [string, string];
    // The full text must reach the file — a truncated file plus a path would
    // be doubly wrong.
    expect(writtenContent).toBe(output);
    expect(writtenPath.startsWith(`${TOOL_OUTPUT_DIR}/`)).toBe(true);
    expect(result.file?.path).toBe(writtenPath);
    expect(result.file?.bytes).toBe(Buffer.byteLength(output, 'utf8'));
    expect(result.file?.originalChars).toBe(output.length);
  });

  it('opens the preview with the single shared marker', async () => {
    const { sandbox } = fakeSandbox();
    const result = await spillToolOutput('z'.repeat(LOCAL_TOOL_RESULT_MAX_CHARS + 10), {
      sessionId: 'sess_1',
      sandbox,
    });

    expect(result.preview.startsWith(TOOL_OVERFLOW_MARKER)).toBe(true);
    expect(result.preview).toContain(`file: ${result.file!.path}`);
    expect(result.preview).toContain(`original_chars: ${LOCAL_TOOL_RESULT_MAX_CHARS + 10}`);
  });

  it('makes the preview far smaller than the original output', async () => {
    const { sandbox } = fakeSandbox();
    const output = 'a'.repeat(LOCAL_TOOL_RESULT_MAX_CHARS + 1);
    const result = await spillToolOutput(output, { sessionId: 'sess_1', sandbox });

    expect(result.preview.length).toBeLessThan(5_000);
  });

  it('does not claim a file path when no sandbox was available', async () => {
    const output = 'b'.repeat(LOCAL_TOOL_RESULT_MAX_CHARS + 1);
    const result = await spillToolOutput(output, { sessionId: 'sess_1' });

    expect(result.file).toBeUndefined();
    expect(result.preview).toContain('file: none');
    expect(result.preview).toContain(TOOL_OVERFLOW_MARKER);
    expect(result.preview).not.toMatch(/file: \//);
  });

  it('degrades to a path-less preview when the write fails', async () => {
    const writeFile = vi.fn(async () => {
      throw new Error('sandbox gone');
    });
    const { sandbox } = fakeSandbox({ writeFile } as Partial<SandboxInstance>);
    const output = 'c'.repeat(LOCAL_TOOL_RESULT_MAX_CHARS + 1);
    const result = await spillToolOutput(output, { sessionId: 'sess_1', sandbox });

    // A failed spill must not fail the turn, and must not promise a file.
    expect(result.file).toBeUndefined();
    expect(result.preview).toContain('file: none');
    expect(result.preview).toContain('No file was written');
  });

  it('keeps the file name a single path segment for an odd session id', async () => {
    const { sandbox, writeFile } = fakeSandbox();
    await spillToolOutput('d'.repeat(LOCAL_TOOL_RESULT_MAX_CHARS + 1), {
      sessionId: '../../etc/passwd',
      sandbox,
      idFactory: () => 'fixed',
    });

    const [writtenPath] = writeFile.mock.calls[0] as unknown as [string, string];
    // `/` collapses into the segment: no separator survives, so no traversal.
    expect(writtenPath).toBe(`${TOOL_OUTPUT_DIR}/etc_passwd-fixed.txt`);
    expect(writtenPath.includes('..')).toBe(false);
  });

  it('names the overflow file deterministically when an id factory is supplied', async () => {
    const { sandbox, writeFile } = fakeSandbox();
    await spillToolOutput('e'.repeat(LOCAL_TOOL_RESULT_MAX_CHARS + 1), {
      sessionId: 'sess_1',
      sandbox,
      idFactory: () => 'abc123',
    });

    const [writtenPath] = writeFile.mock.calls[0] as unknown as [string, string];
    expect(writtenPath).toBe(`${TOOL_OUTPUT_DIR}/sess_1-abc123.txt`);
  });
});

describe('overflowPreview', () => {
  it('is the one place the marker is composed', () => {
    const withFile = overflowPreview('f'.repeat(10_000), {
      limit: 100,
      file: { path: '/mnt/session/tool_outputs/x.txt', bytes: 10_000, originalChars: 10_000 },
    });
    const withoutFile = overflowPreview('f'.repeat(10_000), { limit: 100 });

    for (const preview of [withFile, withoutFile]) {
      expect(preview.startsWith(TOOL_OVERFLOW_MARKER)).toBe(true);
      expect(preview).toContain('original_chars: 10000');
    }
    // The two states must be distinguishable by a reader, not just by a path.
    expect(withFile).toContain('The full output is available');
    expect(withoutFile).toContain('No file was written');
  });

  it('never copies more than the preview budget of body text', () => {
    const preview = overflowPreview('g'.repeat(50_000), { limit: 50_000 });
    const body = preview.slice(preview.indexOf('\n\n') + 2);
    expect(body.length).toBeLessThan(3_000);
  });

  it('reports a zero-length original honestly', () => {
    expect(overflowPreview('', { limit: 0 })).toContain('original_chars: 0');
  });
});
