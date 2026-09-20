/**
 * Tool output overflow contract (published CMA behaviour, locally profiled).
 *
 * The published contract states that a tool whose output exceeds 100,000
 * characters (about 25,000 tokens) has that output written into a file in the
 * sandbox; the model then receives a truncated preview together with the file
 * path and can read the full content from there. The same rule is documented
 * separately for MCP tool output.
 *
 * Two properties have to hold for a local implementation to be honest about
 * this:
 *
 * - **One spill format.** Tools must not each invent their own truncation
 *   marker. Every overflowed result goes through {@link spillToolOutput}, so
 *   the preview, the file path, and the retained-size accounting are identical
 *   no matter which tool produced the bytes.
 * - **The path is real, or it is not claimed.** The model is told it can read
 *   the file back. If the sandbox is unavailable, both strategies fall back to
 *   an in-place truncation that says so explicitly. Reporting a path that was
 *   never written would be a fabricated promise, which is worse than a shorter
 *   preview.
 *
 * The local profile keeps a smaller {@link LOCAL_TOOL_RESULT_MAX_CHARS} ceiling
 * than the published 100,000. That keeps a runaway result from being persisted
 * in full on a developer machine whose SQLite log has no size budget, and the
 * capability matrix records the gap as `partial` rather than `supported`.
 */

import { nanoid } from 'nanoid';
import type { SandboxInstance } from '@/types/sandbox.ts';

/** Published overflow threshold, retained for reference and capability reporting. */
export const CANONICAL_TOOL_RESULT_MAX_CHARS = 100_000;

/** Characters kept in the preview handed back to the model. */
export const TOOL_OVERFLOW_PREVIEW_CHARS = 2_000;

/**
 * Local spill threshold.
 *
 * Smaller than the published value on purpose: a local runtime persists every
 * event into SQLite, so the ceiling also bounds what one session log can grow
 * to. Recorded as a `partial` deviation in the capability matrix.
 */
export const LOCAL_TOOL_RESULT_MAX_CHARS = 50_000;

/** Sandbox directory overflow files are written under. */
export const TOOL_OUTPUT_DIR = '/mnt/session/tool_outputs';

/** Marker opened by every preview. One spelling, so no tool can diverge. */
export const TOOL_OVERFLOW_MARKER = '[tool output overflow]';

export interface ToolOutputOverflowFile {
  /** Absolute sandbox path the full output was written to. */
  path: string;
  /** Bytes actually written (UTF-8), not the pre-truncation character count. */
  bytes: number;
  /** Characters in the original output. */
  originalChars: number;
}

export interface ToolOutputOverflow {
  /** Text the model receives. */
  preview: string;
  /** Present only when the full output really is readable at `path`. */
  file?: ToolOutputOverflowFile;
}

export interface SpillToolOutputDeps {
  sessionId: string;
  /** Sandbox to write into. Absent means "no file was written". */
  sandbox?: SandboxInstance;
  limit?: number;
  /** Injectable for deterministic tests. */
  idFactory?: () => string;
}

/** Whether this output must be spilled rather than passed through. */
export function exceedsToolOutputLimit(value: string, limit = LOCAL_TOOL_RESULT_MAX_CHARS): boolean {
  return value.length > limit;
}

/**
 * Spill an oversized tool output into the sandbox and build the preview.
 *
 * Callers must run the result through this function instead of slicing
 * themselves, so the marker, the retained-size accounting, and the fallback
 * behaviour stay in one place.
 */
export async function spillToolOutput(
  output: string,
  deps: SpillToolOutputDeps,
): Promise<ToolOutputOverflow> {
  const limit = deps.limit ?? LOCAL_TOOL_RESULT_MAX_CHARS;
  if (!exceedsToolOutputLimit(output, limit)) return { preview: output };

  const makeId = deps.idFactory ?? (() => nanoid(10));
  const path = `${TOOL_OUTPUT_DIR}/${toolOutputFileName(deps.sessionId, makeId())}`;
  if (deps.sandbox) {
    try {
      await deps.sandbox.writeFile(path, output);
      return {
        preview: overflowPreview(output, {
          file: { path, bytes: Buffer.byteLength(output, 'utf8'), originalChars: output.length },
          limit,
        }),
        file: { path, bytes: Buffer.byteLength(output, 'utf8'), originalChars: output.length },
      };
    } catch {
      // A failed spill must not fail the turn. Falling through to the
      // path-less preview keeps the agent running and, crucially, does not
      // tell the model to read a file that is not there.
    }
  }
  return { preview: overflowPreview(output, { limit }) };
}

export interface OverflowPreviewOptions {
  file?: ToolOutputOverflowFile;
  limit?: number;
}

/**
 * Render the preview text for an oversize output.
 *
 * Exported separately from the spill so the fallback path and any future
 * caller compose the exact same string.
 */
export function overflowPreview(output: string, options: OverflowPreviewOptions = {}): string {
  const limit = options.limit ?? LOCAL_TOOL_RESULT_MAX_CHARS;
  const kept = output.slice(0, Math.min(TOOL_OVERFLOW_PREVIEW_CHARS, limit));
  const lines = [
    TOOL_OVERFLOW_MARKER,
    `original_chars: ${output.length}`,
    `preview_chars: ${kept.length}`,
  ];
  if (options.file) {
    lines.push(`file: ${options.file.path}`);
    lines.push(`file_bytes: ${options.file.bytes}`);
    lines.push('The full output is available at the path above.');
  } else {
    lines.push(`file: none`);
    lines.push('No file was written; only this preview is available.');
  }
  lines.push('', kept);
  return lines.join('\n');
}

function toolOutputFileName(sessionId: string, id: string): string {
  return `${sanitizeSegment(sessionId)}-${sanitizeSegment(id)}.txt`;
}

/** Keep the written name a single path segment even for an odd session id. */
function sanitizeSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned || 'session';
}
