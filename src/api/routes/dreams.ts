import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import type { ServerDeps } from '../server.js';
import {
  COLLECTION_LISTING_QUERY_PARAMS,
  INCLUDE_ARCHIVED_PARAM,
  parseCollectionWindow,
  parseIncludeArchived,
  rejectUnexpectedQueryParams,
} from './query-params.js';
import { invalid, notFound, readObjectBody } from './resource-utils.js';
import {
  DREAM_STATUSES,
  type DreamRow,
  type DreamStatus,
  dreamInputsProjection,
  getDream,
  parseDreamCreate,
  toApiDream,
} from '@/core/dreams/dream.js';
import {
  cancelDream,
  resolveDreamModel,
  startDream,
  sweepDreams,
  syncDream,
  type DreamRunnerDeps,
} from '@/core/dreams/runner.js';

const DREAM_LIST_ORDER = 'dreams.created_at DESC, dreams.rowid DESC';
/** List filters the published surface accepts, in addition to the shared window params. */
const DREAM_LIST_QUERY_PARAMS = [...COLLECTION_LISTING_QUERY_PARAMS, 'statuses', 'statuses[]', 'created_at[gt]', 'created_at[lt]'];

function runnerDeps(deps: ServerDeps): DreamRunnerDeps {
  return {
    db: deps.db,
    sessionManager: deps.sessionManager,
    dataDir: deps.workspace?.dataDir,
    defaultModelName: () =>
      deps.listRuntimeModels?.().find((model) => model.is_default)?.name
      ?? deps.runtime?.models.find((model) => model.is_default)?.name,
  };
}

export function dreamRoutes(deps: ServerDeps) {
  const app = new Hono();

  app.get('/', async (c) => {
    const rejected = rejectUnexpectedQueryParams(c, DREAM_LIST_QUERY_PARAMS);
    if (rejected) return rejected;
    const includeArchived = parseIncludeArchived(c);
    if (!includeArchived.ok) return includeArchived.response;

    // `statuses` is the published multi-value filter; `statuses[]` is the SDK's
    // serialized spelling. Both are accepted, like the session listing.
    const statusValues = [
      ...(c.req.queries('statuses') ?? []),
      ...(c.req.queries('statuses[]') ?? []),
    ];
    const badStatus = statusValues.find((value) => !DREAM_STATUSES.includes(value as DreamStatus));
    if (badStatus) {
      return invalid(c, `Invalid statuses value "${badStatus}". This route accepts: ${DREAM_STATUSES.join(', ')}.`);
    }
    const statuses = [...new Set(statusValues)] as DreamStatus[];

    const createdGt = c.req.query('created_at[gt]');
    const createdLt = c.req.query('created_at[lt]');
    for (const [name, value] of [['created_at[gt]', createdGt], ['created_at[lt]', createdLt]] as const) {
      if (value !== undefined && Number.isNaN(Date.parse(value))) {
        return invalid(c, `${name} must be an RFC 3339 timestamp`);
      }
    }

    // A list is a read like any other: reconcile before projecting so a dream
    // whose pipeline just finished reports its real status, not a stale one.
    await sweepDreams(runnerDeps(deps));

    const filters: string[] = [];
    const args: Array<string | number> = [];
    if (!includeArchived.value) filters.push('dreams.archived_at IS NULL');
    if (statuses.length > 0) {
      filters.push(`dreams.status IN (${statuses.map(() => '?').join(', ')})`);
      args.push(...statuses);
    }
    if (createdGt !== undefined) { filters.push('dreams.created_at > ?'); args.push(createdGt); }
    if (createdLt !== undefined) { filters.push('dreams.created_at < ?'); args.push(createdLt); }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

    const window = parseCollectionWindow(c, {
      order: DREAM_LIST_ORDER,
      filter: {
        ...(includeArchived.value ? { [INCLUDE_ARCHIVED_PARAM]: 'true' } : {}),
        ...(statuses.length ? { statuses: statuses.join(',') } : {}),
      },
    });
    if (!window.ok) return window.response;

    const rows = deps.db.prepare(`SELECT * FROM dreams ${where} ORDER BY dreams.created_at DESC, dreams.rowid DESC`).all(...args) as unknown as DreamRow[];
    return c.json(window.value.slice(rows.map(toApiDream)));
  });

  app.post('/', async (c) => {
    const body = await readObjectBody(c);
    if (!body.ok) return body.response;
    const parsed = parseDreamCreate(body.value);
    if (!parsed.ok) return invalid(c, parsed.message, parsed.code);

    const store = deps.db.prepare('SELECT id, archived_at FROM memory_stores WHERE id = ?').get(parsed.value.memoryStoreId) as
      | { id: string; archived_at: string | null }
      | undefined;
    if (!store) return invalid(c, `Memory store not found: ${parsed.value.memoryStoreId}`, 'memory_store_not_found');
    if (store.archived_at) return invalid(c, `Memory store ${parsed.value.memoryStoreId} is archived`, 'memory_store_archived');

    const missing = parsed.value.sessionIds.filter(
      (id) => !deps.db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(id),
    );
    if (missing.length > 0) {
      return invalid(c, `Session not found: ${missing.join(', ')}`, 'session_not_found');
    }

    // The published single-writer rule: while another update_existing dream on
    // the same store hasn't fully stopped, the create is a conflict.
    if (parsed.value.outputBehavior.type === 'update_existing') {
      const held = deps.db.prepare(
        `SELECT id FROM dreams
         WHERE input_store_id = ? AND output_store_id = ?
           AND status IN ('pending', 'running') AND archived_at IS NULL
         LIMIT 1`,
      ).get(parsed.value.memoryStoreId, parsed.value.memoryStoreId) as { id: string } | undefined;
      if (held) {
        // The published `BetaTargetStoreHeldError`: `conflict_error` (not the
        // local `conflict` type) with `x-should-retry: false`, and the message
        // names the dream still holding the store.
        c.header('x-should-retry', 'false');
        return c.json(
          { error: { type: 'conflict_error', code: 'target_store_held', message: `Memory store ${parsed.value.memoryStoreId} is the update target of active dream ${held.id}` } },
          409,
        );
      }
    }

    const model = resolveDreamModel(runnerDeps(deps), parsed.value.model);
    if (!model) {
      return invalid(c, 'No dream model resolved: pass model in the request, set dreams.model in settings, or configure a workspace default model', 'model_not_configured');
    }

    const id = `drm_${nanoid(18)}`;
    deps.db.prepare(
      `INSERT INTO dreams (id, status, inputs, instructions, model, output_behavior, input_store_id)
       VALUES (?, 'pending', ?, ?, ?, ?, ?)`,
    ).run(
      id,
      JSON.stringify(dreamInputsProjection(parsed.value)),
      parsed.value.instructions,
      JSON.stringify(model),
      JSON.stringify(parsed.value.outputBehavior),
      parsed.value.memoryStoreId,
    );

    const dream = await startDream(runnerDeps(deps), getDream(deps.db, id)!);
    return c.json(toApiDream(dream), 201);
  });

  app.get('/:id', async (c) => {
    const dream = getDream(deps.db, c.req.param('id'));
    if (!dream) return notFound(c, 'Dream not found');
    const synced = await syncDream(runnerDeps(deps), dream);
    return c.json(toApiDream(synced));
  });

  app.post('/:id/cancel', async (c) => {
    let dream = getDream(deps.db, c.req.param('id'));
    if (!dream || dream.archived_at) return notFound(c, 'Dream not found');
    dream = await syncDream(runnerDeps(deps), dream);
    if (!['pending', 'running'].includes(dream.status)) {
      return invalid(c, `Dream ${dream.id} is already ${dream.status}; only pending or running dreams can be canceled`, 'dream_not_active');
    }
    await cancelDream(runnerDeps(deps), dream);
    return c.json(toApiDream(getDream(deps.db, dream.id)!));
  });

  app.post('/:id/archive', async (c) => {
    let dream = getDream(deps.db, c.req.param('id'));
    if (!dream) return notFound(c, 'Dream not found');
    dream = await syncDream(runnerDeps(deps), dream);
    if (dream.archived_at) return c.json(toApiDream(dream));
    if (['pending', 'running'].includes(dream.status)) {
      return invalid(c, `Dream ${dream.id} is ${dream.status}; cancel it before archiving`, 'dream_active');
    }
    deps.db.prepare(`UPDATE dreams SET archived_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(dream.id);
    return c.json(toApiDream(getDream(deps.db, dream.id)!));
  });

  return app;
}
