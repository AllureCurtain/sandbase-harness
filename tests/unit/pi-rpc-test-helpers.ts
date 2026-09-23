/**
 * Shared fakes for the Pi RPC tests.
 *
 * Kept outside the collected test glob (only `*.test.ts` under `tests/` is
 * collected) on purpose: this file contains no assertions, and a file named as
 * a test but containing none is a lie to whatever reads the report.
 *
 * The wire is two `PassThrough` streams plus a decodable record of what the
 * runtime wrote, which is enough to exercise framing, correlation, and the gate
 * without a child process. Anything that needs a real `ChildProcess` builds one
 * where it is used.
 */

import { PassThrough } from 'node:stream';

export interface PiRpcWire {
  /** Written by the runtime, read by the fake Pi. */
  stdin: PassThrough;
  /** Written by the fake Pi, read by the runtime. */
  stdout: PassThrough;
  /** Every complete LF-delimited record the runtime wrote, parsed. */
  written: Record<string, unknown>[];
  /** Push one JSON record as Pi would emit it. */
  say: (frame: unknown) => void;
  /** Push a raw line, for framing and malformed-frame cases. */
  sayRaw: (line: string) => void;
  /** End stdout, as a child exiting would. */
  end: () => void;
}

export function createPiRpcWire(): PiRpcWire {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const written: Record<string, unknown>[] = [];
  let buffer = '';
  stdin.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    for (;;) {
      const index = buffer.indexOf('\n');
      if (index < 0) return;
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.trim()) written.push(JSON.parse(line) as Record<string, unknown>);
    }
  });
  return {
    stdin,
    stdout,
    written,
    say: (frame) => { stdout.write(`${JSON.stringify(frame)}\n`); },
    sayRaw: (line) => { stdout.write(line); },
    end: () => { stdout.end(); },
  };
}

/** Let queued promises and stream callbacks run. */
export async function settleAsync(times = 6): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
  }
}

/** Poll until `condition` holds, or fail loudly instead of hanging the suite. */
export async function waitFor(condition: () => boolean, label = 'condition'): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  throw new Error(`Timed out waiting for ${label}`);
}
