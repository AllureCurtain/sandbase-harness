/**
 * Session outputs — runtime wiring.
 *
 * `session-outputs.test.ts` proves the collector and the recorder behave. It
 * cannot prove anything calls them: an executor that never walks the output root
 * would leave those tests green. These tests pin the wiring, because "the
 * deliverables become retrievable" is a property of the call site.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (relative: string) => readFileSync(join(process.cwd(), relative), 'utf8');

describe('session output wiring', () => {
  it('collects the output root after every turn', () => {
    const source = read('src/core/session/executor.ts');

    // The collection runs after the snapshot step, so it sees everything the
    // agent wrote during the turn rather than a mid-turn directory.
    const snapshotIndex = source.indexOf('snapshotAfterTurn(session, sandbox)');
    const collectIndex = source.indexOf('collectSessionOutputs(sandbox)');
    expect(snapshotIndex).toBeGreaterThan(-1);
    expect(collectIndex).toBeGreaterThan(snapshotIndex);
  });

  it('swallows a collection failure so a completed turn is not reported as failed', () => {
    const source = read('src/core/session/executor.ts');

    const helper = source.slice(
      source.indexOf('private async publishSessionOutputs'),
      source.indexOf('private skillDirsFor'),
    );
    expect(helper).toContain('try {');
    expect(helper).toContain('} catch {');
    // The output directory is re-read on the next turn, so a swallow is safe.
    expect(helper).toContain('re-read on the next turn');
  });

  it('makes the sink optional so an embedder with no Files API still runs', () => {
    const source = read('src/core/session/executor.ts');
    expect(source).toContain('sessionOutputSink?:');
    expect(source).toContain('if (!sink) return;');
  });

  it('wires the recorder into the runtime session services', () => {
    const source = read('src/core/runtime/session-runtime.ts');
    expect(source).toContain('recordSessionOutputs({');
    expect(source).toContain('sessionOutputSink:');
  });
});
