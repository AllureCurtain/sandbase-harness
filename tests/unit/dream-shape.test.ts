/**
 * Unit tests for the dream request contract (`src/core/dreams/dream.ts`).
 *
 * The published `DreamCreateParams` is strict about its shape — exactly one
 * memory-store input and one sessions input, 1-100 unique session ids, a
 * 1-4096 character instructions string, a model id or {id, speed:'standard'}
 * object, and a create_new/update_existing output behavior. These tests pin
 * each boundary so an acceptance loosened by accident fails here, and pin the
 * response projection's invariants (`type: 'dream'`, model always an object,
 * sessions ids sorted, `outputs` empty until an output store is recorded).
 */

import { describe, expect, it } from 'vitest';
import { Database } from '@/core/db/database.js';
import {
  DREAM_INSTRUCTIONS_MAX_CHARS,
  DREAM_SESSION_IDS_MAX,
  type DreamRow,
  parseDreamCreate,
  toApiDream,
} from '@/core/dreams/dream.js';

const VALID = {
  inputs: [
    { type: 'memory_store', memory_store_id: 'memstore_in' },
    { type: 'sessions', session_ids: ['sess_b', 'sess_a'] },
  ],
};

function parse(body: Record<string, unknown>) {
  return parseDreamCreate(body);
}

describe('parseDreamCreate', () => {
  it('accepts the minimal published shape and sorts session ids for the echo', () => {
    const parsed = parse(VALID);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.memoryStoreId).toBe('memstore_in');
      expect(parsed.value.sessionIds).toEqual(['sess_a', 'sess_b']);
      expect(parsed.value.instructions).toBeNull();
      expect(parsed.value.model).toBeNull();
      expect(parsed.value.outputBehavior).toEqual({ type: 'create_new' });
    }
  });

  it('refuses unknown top-level fields instead of dropping them', () => {
    const parsed = parse({ ...VALID, metadata: { a: 'b' } });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toContain("Unknown parameter: 'metadata'");
  });

  it('requires inputs as an array of exactly one memory_store and one sessions entry', () => {
    for (const inputs of [
      undefined,
      'x',
      [],
      [{ type: 'memory_store', memory_store_id: 'a' }],
      [
        { type: 'memory_store', memory_store_id: 'a' },
        { type: 'memory_store', memory_store_id: 'b' },
        { type: 'sessions', session_ids: ['s'] },
      ],
      [{ type: 'sessions', session_ids: ['s'] }],
    ]) {
      expect(parse({ inputs }).ok, JSON.stringify(inputs)).toBe(false);
    }
  });

  it('refuses unknown input types by name rather than ignoring them', () => {
    const parsed = parse({
      inputs: [
        { type: 'memory_store', memory_store_id: 'a' },
        { type: 'sessions', session_ids: ['s'] },
        { type: 'files', file_ids: ['f'] },
      ],
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toContain('memory_store');
  });

  it('bounds session_ids at 1-100 unique non-empty strings', () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `sess_${i}`);
    const over = parse({
      inputs: [
        { type: 'memory_store', memory_store_id: 'a' },
        { type: 'sessions', session_ids: ids(DREAM_SESSION_IDS_MAX + 1) },
      ],
    });
    expect(over.ok).toBe(false);

    const empty = parse({ inputs: [{ type: 'memory_store', memory_store_id: 'a' }, { type: 'sessions', session_ids: [] }] });
    expect(empty.ok).toBe(false);

    const dup = parse({
      inputs: [{ type: 'memory_store', memory_store_id: 'a' }, { type: 'sessions', session_ids: ['s', 's'] }],
    });
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.message).toContain('duplicates');

    const nonString = parse({
      inputs: [{ type: 'memory_store', memory_store_id: 'a' }, { type: 'sessions', session_ids: ['s', 7] }],
    });
    expect(nonString.ok).toBe(false);
  });

  it('bounds instructions at the published 1-4096 characters', () => {
    expect(parse({ ...VALID, instructions: '' }).ok).toBe(false);
    expect(parse({ ...VALID, instructions: 'x'.repeat(DREAM_INSTRUCTIONS_MAX_CHARS) }).ok).toBe(true);
    expect(parse({ ...VALID, instructions: 'x'.repeat(DREAM_INSTRUCTIONS_MAX_CHARS + 1) }).ok).toBe(false);
    expect(parse({ ...VALID, instructions: 42 }).ok).toBe(false);
    // Explicit null is the SDK's "no guidance" spelling and must not refuse.
    const nulled = parse({ ...VALID, instructions: null });
    expect(nulled.ok).toBe(true);
    if (nulled.ok) expect(nulled.value.instructions).toBeNull();
  });

  it('accepts model as a string id or {id, speed:"standard"}, refusing fast', () => {
    const str = parse({ ...VALID, model: 'claude-x' });
    expect(str.ok && str.value.model).toEqual({ id: 'claude-x' });

    const obj = parse({ ...VALID, model: { id: 'claude-x', speed: 'standard' } });
    expect(obj.ok && obj.value.model).toEqual({ id: 'claude-x', speed: 'standard' });

    const fast = parse({ ...VALID, model: { id: 'claude-x', speed: 'fast' } });
    expect(fast.ok).toBe(false);
    if (!fast.ok) expect(fast.message).toContain('standard');

    expect(parse({ ...VALID, model: { speed: 'standard' } }).ok).toBe(false);
    expect(parse({ ...VALID, model: 5 }).ok).toBe(false);
    // `model: null` is the SDK spelling of "no request override" — the
    // settings/workspace fallbacks then apply, so it parses rather than refuses.
    const nulled = parse({ ...VALID, model: null });
    expect(nulled.ok && nulled.value.model).toBeNull();
  });

  it('accepts update_existing only when it targets the input store', () => {
    const ok = parse({ ...VALID, output_behavior: { type: 'update_existing', memory_store_id: 'memstore_in' } });
    expect(ok.ok && ok.value.outputBehavior).toEqual({ type: 'update_existing', memory_store_id: 'memstore_in' });

    const other = parse({ ...VALID, output_behavior: { type: 'update_existing', memory_store_id: 'memstore_other' } });
    expect(other.ok).toBe(false);

    const missingTarget = parse({ ...VALID, output_behavior: { type: 'update_existing' } });
    expect(missingTarget.ok).toBe(false);

    const bogus = parse({ ...VALID, output_behavior: { type: 'append' } });
    expect(bogus.ok).toBe(false);
  });
});

describe('toApiDream', () => {
  function row(over: Partial<DreamRow> = {}): DreamRow {
    return {
      id: 'drm_x',
      status: 'running',
      inputs: JSON.stringify([
        { type: 'memory_store', memory_store_id: 'memstore_in' },
        { type: 'sessions', session_ids: ['sess_a', 'sess_b'] },
      ]),
      instructions: null,
      model: JSON.stringify({ id: 'claude-x' }),
      output_behavior: JSON.stringify({ type: 'create_new' }),
      input_store_id: 'memstore_in',
      output_store_id: null,
      session_id: null,
      error_type: null,
      error_message: null,
      usage_input_tokens: 3,
      usage_output_tokens: 4,
      usage_cache_read_input_tokens: 5,
      usage_cache_creation_input_tokens: 6,
      created_at: '2026-10-05 00:00:00',
      updated_at: '2026-10-05 00:00:00',
      ended_at: null,
      archived_at: null,
      ...over,
    };
  }

  it('projects the published shape: model object, usage block, empty outputs', () => {
    const api = toApiDream(row());
    expect(api.type).toBe('dream');
    expect(api.id).toBe('drm_x');
    // The response always gives the model as an object, even though the row
    // stores the same JSON the request supplied.
    expect(api.model).toEqual({ id: 'claude-x' });
    expect(api.outputs).toEqual([]);
    expect(api.session_id).toBeNull();
    expect(api.error).toBeNull();
    expect(api.usage).toEqual({
      cache_creation_input_tokens: 6,
      cache_read_input_tokens: 5,
      input_tokens: 3,
      output_tokens: 4,
    });
    expect(api.inputs).toEqual([
      { type: 'memory_store', memory_store_id: 'memstore_in' },
      { type: 'sessions', session_ids: ['sess_a', 'sess_b'] },
    ]);
  });

  it('projects the output store and the pipeline session once recorded', () => {
    const api = toApiDream(row({ output_store_id: 'memstore_out', session_id: 'sess_pipe' }));
    expect(api.outputs).toEqual([{ type: 'memory_store', memory_store_id: 'memstore_out' }]);
    expect(api.session_id).toBe('sess_pipe');
  });

  it('projects failure detail only when an error type was recorded', () => {
    const api = toApiDream(row({ status: 'failed', error_type: 'timeout', error_message: 'stalled' }));
    expect(api.error).toEqual({ type: 'timeout', message: 'stalled' });
    expect(toApiDream(row({ status: 'canceled' })).error).toBeNull();
  });
});

describe('dreams table migration', () => {
  it('migrates a fresh database with the dreams table and its indexes', () => {
    const db = new Database(':memory:');
    db.runMigrations();
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'dreams'").get();
    expect(table).toBeTruthy();
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'dreams'").all() as Array<{ name: string }>;
    expect(indexes.map((i) => i.name).sort()).toEqual(
      ['idx_dreams_created_at', 'idx_dreams_session_id', 'idx_dreams_status', 'sqlite_autoindex_dreams_1'].sort(),
    );
    db.close();
  });
});
