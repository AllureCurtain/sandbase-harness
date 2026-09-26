/**
 * The memory record path validator.
 *
 * `normalizeMemoryRecordPath` is where a caller's logical path becomes a store
 * path, so every rejection here is a boundary worth pinning: a relative path,
 * the bare root, a trailing slash, `.` and `..` segments, and a NUL byte.
 *
 * The refusals must also be *identifiable*. The error code is what a caller
 * switches on, and the message is the only thing that says which rule was
 * broken — a mount that reports only that it failed leaves the caller unable to
 * tell "you sent a relative path" from "you sent a traversal", which are very
 * different things to report back to a user.
 */

import { describe, expect, it } from 'vitest';
import { normalizeMemoryRecordPath } from '@/core/memory/mount-adapter.js';

/** Every refusal from this validator is the same code, with the reason in the message. */
function expectRefusal(path: string): void {
  const result = normalizeMemoryRecordPath(path);

  expect(result.ok, `${JSON.stringify(path)} must be refused`).toBe(false);
  if (result.ok) return;
  expect(result.error.code).toBe('invalid_path');
  expect(result.error.message).toContain('invalid path:');
}

describe('normalizeMemoryRecordPath', () => {
  it('accepts a well-formed record path', () => {
    // The refusals below are only meaningful if a good path still passes.
    expect(normalizeMemoryRecordPath('/notes/a.md').ok).toBe(true);
  });

  it('refuses a relative path', () => {
    expectRefusal('notes/a.md');
  });

  it('refuses the bare root', () => {
    expectRefusal('/');
  });

  it('refuses a trailing slash, which names a directory rather than a record', () => {
    expectRefusal('/notes/');
  });

  it('refuses parent- and current-directory segments', () => {
    expectRefusal('/../escape');
    expectRefusal('/a/../b');
    expectRefusal('/a/./b');
  });

  it('refuses a NUL byte', () => {
    expectRefusal('/a\0b');
  });
});
