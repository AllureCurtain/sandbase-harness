/**
 * Pi boundary truthfulness.
 *
 * The runtime ships two executable engines, but they do not carry the same
 * guarantees: `builtin` runs the Harness tool loop with one-shot confirmation
 * and local path policy, while `pi` drives a host-local CLI whose native tools
 * sit outside both. These assertions keep the boundary explicit in code and
 * user-facing documentation.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PI_LOOP_ENGINE_REASON,
  ROADMAP_LOOP_ENGINE_REASON,
  describeLoopEngineAdapters,
  loopEngineDescriptor,
} from '@/core/settings/adapters.js';

function doc(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

describe('loop engine capability truthfulness', () => {
  const adapters = describeLoopEngineAdapters();

  it('advertises the Harness tool-loop guarantees only for builtin', () => {
    const builtin = loopEngineDescriptor('builtin');
    const pi = loopEngineDescriptor('pi');

    expect(builtin?.status).toBe('available');
    expect(builtin?.capabilities).toEqual(expect.arrayContaining(['harness-tool-loop', 'tool-confirmation']));

    expect(pi?.status).toBe('available');
    expect(pi?.capabilities ?? []).not.toContain('tool-confirmation');
    expect(pi?.capabilities).not.toContain('harness-tool-loop');
  });

  it('reports why Pi is not a peer of builtin instead of hiding the restriction', () => {
    const pi = loopEngineDescriptor('pi');

    expect(pi?.reason).toBe(PI_LOOP_ENGINE_REASON);
    expect(PI_LOOP_ENGINE_REASON).toContain('not governed by Harness approval');
    expect(PI_LOOP_ENGINE_REASON).toContain('sandbox path policy');
    expect(pi?.requirements).toEqual(['Pi CLI available on PATH', 'local sandbox provider']);
  });

  it('keeps roadmap engines unavailable with an explicit reason', () => {
    for (const id of ['harness', 'codex', 'claude']) {
      const descriptor = loopEngineDescriptor(id);
      expect(descriptor?.status, id).toBe('unavailable');
      expect(descriptor?.reason, id).toBe(ROADMAP_LOOP_ENGINE_REASON);
    }
    expect(adapters.map((adapter) => adapter.id)).toEqual(['builtin', 'pi', 'harness', 'codex', 'claude']);
  });

  it('publishes the same boundary in the user-facing docs', () => {
    const api = doc('docs/api.md');
    const piGuide = doc('docs/pi-loop-engine.md');

    expect(api).toContain(PI_LOOP_ENGINE_REASON);
    expect(piGuide).toContain('not receive Harness `always_ask` approval');
    expect(piGuide).toContain('Docker/Kubernetes Pi transport and a Pi→Harness approval bridge remain');
    expect(api).toContain('Pi-native tool events are trajectory records only');
  });

  it('describes the transport the runtime actually runs', () => {
    const pi = loopEngineDescriptor('pi');
    const piGuide = doc('docs/pi-loop-engine.md');

    // The transport changed from a print-mode process per turn to one
    // session-owned RPC child, so the advertised capability ids have to say so;
    // a client that branched on `stdout-jsonl` was branching on a mode this
    // runtime no longer runs.
    expect(pi?.capabilities).toContain('rpc-jsonl');
    expect(pi?.capabilities).not.toContain('stdout-jsonl');
    expect(piGuide).toContain('pi --mode rpc');
    expect(piGuide).not.toContain('-p --mode json');
  });
});
