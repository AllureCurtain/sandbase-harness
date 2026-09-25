import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import type { ServerDeps } from '../server.js';
import { collectionPager } from '../standard.js';
import { nextCronRun, runDueScheduledDeployments, runSchedule } from '@/core/operations/scheduler.js';
import { isValidTimeZone } from '@/core/operations/cron.js';
import {
  archiveById,
  equalJsonObject,
  invalid,
  notFound,
  now,
  objectField,
  parseObject,
  readObjectBody,
  stringField,
  type JsonObject,
  type OperationMountOptions,
} from './operation-helpers.js';
import { publishOperationEvent, publishPauseTransition } from './operation-events.js';

/**
 * Scheduled deployments, addressed at two prefixes.
 *
 * The published contract calls this resource a *deployment* and addresses it at
 * `/v1/deployments*`; this runtime has always called it a *scheduled deployment*
 * and served it at `/v1/scheduled-deployments*`. Both spellings are served.
 *
 * The routes are declared **relative to the mount** and `operations.ts` mounts
 * this one factory at `/scheduled-deployments` and at `/deployments`, so there is
 * one registration list and the two prefixes cannot drift route by route. A
 * curated per-route alias list is exactly the thing that drifts, leaving a route
 * that answers for one caller and 404s for another on the same resource.
 *
 * Two constraints shape this file, and both are load-bearing:
 *
 * 1. The paths must stay **literals**, and the aliasing must happen at
 *    `app.route()`. `tests/unit/support/route-table.ts` expands
 *    `app.<method>('<literal>'` and `app.route('<prefix>', factory)` statically
 *    from source text, so a path built from a base-path variable would make these
 *    routes invisible to the Console's API-reference guard and to
 *    `contract-honesty` while they kept working — a guard reporting green over a
 *    real divergence.
 * 2. This factory must live in its **own module** and be imported by
 *    `operations.ts`, because that parser only follows a mount whose factory is
 *    an imported identifier. Defining it in the same file as the mount would
 *    leave it unresolved and drop every deployment route from the table.
 *
 * `operations.ts` serves four resource families from one router mounted at `/v1`
 * and mirrored at `/v1/x`. That is why the deployments were **extracted** rather
 * than aliased in place: making that router's paths relative and remounting it
 * would have put `/webhooks` and `/outcomes` under `/v1/deployments/` as well.
 * Mounting this factory inside `operationsRoutes` (rather than in `server.ts`)
 * deliberately preserves the existing `/v1/x/scheduled-deployments` mirror, which
 * `tests/integration/operations-collection-envelope.test.ts` asserts, and gives
 * `/v1/x/deployments` the same legacy envelope as its canonical-prefix twin.
 */
export function deploymentRoutes(deps: ServerDeps, options: OperationMountOptions = {}) {
  const app = new Hono();
  const collections = collectionPager<{ id: string }>(options.pageShape ?? 'canonical');

  app.get('/', (c) => {
    const rows = deps.db.prepare('SELECT * FROM scheduled_deployments WHERE archived_at IS NULL ORDER BY created_at DESC').all() as ScheduledDeploymentRow[];
    return collections.json(c, rows.map(toScheduledDeployment));
  });

  app.post('/', async (c) => {
    const body = await readObjectBody(c);
    if (!body.ok) return body.response;
    const name = stringField(body.value.name);
    const agentId = stringField(body.value.agent_id) ?? stringField(body.value.agent);
    if (!name) return invalid(c, 'name is required');
    if (!agentId) return invalid(c, 'agent_id is required');
    const schedule = parseScheduleFields(body.value);
    if (!schedule.ok) return invalid(c, schedule.message);
    const status = normalizeScheduleStatus(body.value.status);
    const id = `sched_${nanoid(18)}`;
    deps.db.prepare(`
      INSERT INTO scheduled_deployments (
        id, name, agent_id, environment_id, cron, timezone, payload, status, paused_reason, next_run_at, metadata, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      name,
      agentId,
      stringField(body.value.environment_id) ?? null,
      schedule.expression,
      schedule.timezone,
      JSON.stringify(objectField(body.value.payload)),
      status,
      pauseReasonFor(status),
      stringField(body.value.next_run_at) ?? nextCronRun(schedule.expression, new Date(), schedule.timezone)?.toISOString() ?? null,
      JSON.stringify(objectField(body.value.metadata)),
      now(),
      now(),
    );
    const row = deps.db.prepare('SELECT * FROM scheduled_deployments WHERE id = ?').get(id) as ScheduledDeploymentRow;
    // Published after the row exists, so a receiver that follows the reference
    // immediately finds the deployment rather than a 404. A create that failed
    // validation returned above this point and publishes nothing, for the same
    // reason: there is no id to name.
    //
    // A deployment created already `paused` publishes only this event. The pause
    // events report a transition, and nothing moved here — there was no unpaused
    // state before it — so publishing `deployment.paused` would assert a
    // transition that did not happen. The receiver learns the status by resolving
    // this reference, which is the mechanism the published contract supplies.
    await publishOperationEvent(deps, {
      event: 'deployment.created',
      data: { type: 'deployment', id },
    });
    return c.json(toScheduledDeployment(row), 201);
  });

  app.post('/run-due', (c) => {
    const runs = runDueScheduledDeployments(deps.db, deps.sessionManager);
    return collections.json(c, runs.map(toScheduledDeploymentRun), 202);
  });

  app.get('/:id', (c) => {
    const row = deps.db.prepare('SELECT * FROM scheduled_deployments WHERE id = ? AND archived_at IS NULL').get(c.req.param('id')) as ScheduledDeploymentRow | undefined;
    return row ? c.json(toScheduledDeployment(row)) : notFound(c, 'Scheduled deployment not found');
  });

  app.put('/:id', async (c) => {
    const body = await readObjectBody(c);
    if (!body.ok) return body.response;
    const id = c.req.param('id');
    const existing = deps.db.prepare('SELECT * FROM scheduled_deployments WHERE id = ? AND archived_at IS NULL').get(id) as ScheduledDeploymentRow | undefined;
    if (!existing) return notFound(c, 'Scheduled deployment not found');
    const storedTimeZone = existing.timezone || 'UTC';
    const schedule = parseScheduleFields({
      cron: body.value.cron ?? existing.cron,
      timezone: body.value.timezone ?? storedTimeZone,
      schedule: body.value.schedule,
    });
    if (!schedule.ok) return invalid(c, schedule.message);
    // An update that moves the cadence re-arms the next run in the resolved zone
    // unless the caller supplied one, so changing only the timezone moves the
    // schedule instead of leaving it at the instant the previous zone produced.
    const cadenceChanged = schedule.expression !== existing.cron || schedule.timezone !== storedTimeZone;
    const computedNextRunAt = nextCronRun(schedule.expression, new Date(), schedule.timezone)?.toISOString() ?? null;
    const nextRunAt = body.value.next_run_at === undefined
      ? (cadenceChanged ? computedNextRunAt : existing.next_run_at)
      : stringField(body.value.next_run_at) ?? computedNextRunAt;
    const status = normalizeScheduleStatus(body.value.status ?? existing.status);
    // Every value the write below uses is resolved first, so the same values can
    // decide whether anything changed. Reading them twice is how a comparison
    // comes to describe a different write than the one that happened.
    const nextName = stringField(body.value.name) ?? existing.name;
    const nextAgentId = stringField(body.value.agent_id) ?? stringField(body.value.agent) ?? existing.agent_id;
    const nextEnvironmentId = body.value.environment_id === undefined ? existing.environment_id : stringField(body.value.environment_id) ?? null;
    const nextPayload = body.value.payload === undefined ? parseObject(existing.payload) : objectField(body.value.payload);
    const nextMetadata = body.value.metadata === undefined ? parseObject(existing.metadata) : objectField(body.value.metadata);
    deps.db.prepare(`
      UPDATE scheduled_deployments
      SET name = ?, agent_id = ?, environment_id = ?, cron = ?, timezone = ?, payload = ?, status = ?,
          paused_reason = ?, next_run_at = ?, metadata = ?, updated_at = ?
      WHERE id = ?
    `).run(
      nextName,
      nextAgentId,
      nextEnvironmentId,
      schedule.expression,
      schedule.timezone,
      JSON.stringify(nextPayload),
      status,
      pauseReasonFor(status),
      nextRunAt,
      JSON.stringify(nextMetadata),
      now(),
      id,
    );
    const row = deps.db.prepare('SELECT * FROM scheduled_deployments WHERE id = ?').get(id) as ScheduledDeploymentRow;
    // This route can change two different things, and each is reported by its own
    // event. The fields below are compared against the row that was read before
    // the write, and the comparison is structural because the stored `payload` and
    // `metadata` are serializations: a text comparison would report a change for
    // the same object re-sent with its keys in another order.
    //
    // `status` and `paused_reason` are deliberately absent. They belong to the
    // pause transition, which has dedicated events, and which the two pause routes
    // also perform — if this event covered them, a `POST /{id}/pause` would have to
    // publish `deployment.updated` too, contradicting the published design of a
    // dedicated event for that transition. `updated_at` is absent because it moves
    // on every write by construction, so counting it would make the published
    // no-op rule unreachable.
    const fieldsChanged = (
      nextName !== existing.name
      || nextAgentId !== existing.agent_id
      || nextEnvironmentId !== (existing.environment_id ?? null)
      || schedule.expression !== existing.cron
      || schedule.timezone !== storedTimeZone
      || nextRunAt !== (existing.next_run_at ?? null)
      || !equalJsonObject(existing.payload, nextPayload)
      || !equalJsonObject(existing.metadata, nextMetadata)
    );
    if (fieldsChanged) {
      await publishOperationEvent(deps, {
        event: 'deployment.updated',
        data: { type: 'deployment', id },
      });
    }
    // A `PUT` can change the pause state through its `status` field, which is a
    // third door onto the same state. Publishing from here is what keeps the
    // event tied to the transition rather than to the route that caused it.
    await publishPauseTransition(deps, id, normalizeScheduleStatus(existing.status), status);
    return c.json(toScheduledDeployment(row));
  });

  app.post('/:id/pause', async (c) => {
    const id = c.req.param('id');
    const existing = deps.db.prepare('SELECT * FROM scheduled_deployments WHERE id = ? AND archived_at IS NULL').get(id) as ScheduledDeploymentRow | undefined;
    if (!existing) return notFound(c, 'Scheduled deployment not found');
    // Idempotent: pausing a paused deployment re-records the same reason rather
    // than erroring, because the caller's intent is already satisfied and a 409
    // would make a retried request fail for no reason.
    deps.db.prepare('UPDATE scheduled_deployments SET status = ?, paused_reason = ?, updated_at = ? WHERE id = ?')
      .run('paused', pauseReasonFor('paused'), now(), id);
    const row = deps.db.prepare('SELECT * FROM scheduled_deployments WHERE id = ?').get(id) as ScheduledDeploymentRow;
    await publishPauseTransition(deps, id, normalizeScheduleStatus(existing.status), 'paused');
    return c.json(toScheduledDeployment(row));
  });

  app.post('/:id/unpause', async (c) => {
    const id = c.req.param('id');
    const existing = deps.db.prepare('SELECT * FROM scheduled_deployments WHERE id = ? AND archived_at IS NULL').get(id) as ScheduledDeploymentRow | undefined;
    if (!existing) return notFound(c, 'Scheduled deployment not found');
    const resumeAt = nextRunAfterResume(existing);
    deps.db.prepare('UPDATE scheduled_deployments SET status = ?, paused_reason = ?, next_run_at = ?, updated_at = ? WHERE id = ?')
      .run('active', null, resumeAt, now(), id);
    const row = deps.db.prepare('SELECT * FROM scheduled_deployments WHERE id = ?').get(id) as ScheduledDeploymentRow;
    await publishPauseTransition(deps, id, normalizeScheduleStatus(existing.status), 'active');
    return c.json(toScheduledDeployment(row));
  });

  app.post('/:id/archive', (c) => archiveById(c, deps, 'scheduled_deployments', toScheduledDeployment, 'Scheduled deployment not found'));

  app.get('/:id/runs', (c) => {
    const schedule = deps.db.prepare('SELECT id FROM scheduled_deployments WHERE id = ? AND archived_at IS NULL').get(c.req.param('id'));
    if (!schedule) return notFound(c, 'Scheduled deployment not found');
    const rows = deps.db.prepare('SELECT * FROM scheduled_deployment_runs WHERE schedule_id = ? ORDER BY started_at DESC').all(c.req.param('id')) as ScheduledDeploymentRunRow[];
    return collections.json(c, rows.map(toScheduledDeploymentRun));
  });

  app.post('/:id/run', async (c) => {
    const body = await readObjectBody(c);
    if (!body.ok) return body.response;
    const schedule = deps.db.prepare('SELECT * FROM scheduled_deployments WHERE id = ? AND archived_at IS NULL').get(c.req.param('id')) as ScheduledDeploymentRow | undefined;
    if (!schedule) return notFound(c, 'Scheduled deployment not found');
    // A paused deployment is still runnable by hand. The published contract says
    // so outright — "暂停期间仍允许通过 `run` 端点进行手动运行" (`定时部署.md:490`) —
    // because pause suppresses the *scheduler*, not the endpoint. This route used
    // to refuse any status other than `active`, which made pause mean "cannot be
    // run at all" and left an operator with no way to drain a paused deployment.
    //
    // The refusal is removed rather than narrowed to `paused` alone, because the
    // guard was unreachable for every other value: the query above already
    // excludes archived rows, and `normalizeScheduleStatus` maps everything that
    // is not `paused` to `active`. So the only status it could ever have seen
    // besides `active` is the one the contract says must be allowed, and an
    // `=== 'archived'` check here would be dead code asserting nothing.
    const payload = {
      ...parseObject(schedule.payload),
      ...objectField(body.value.payload),
    };
    const manualSchedule = {
      ...schedule,
      payload: JSON.stringify(payload),
    };
    try {
      const row = runSchedule(deps.db, deps.sessionManager, manualSchedule, stringField(body.value.trigger_type) ?? 'manual');
      return c.json(toScheduledDeploymentRun(row), 201);
    } catch (err: any) {
      return c.json({ error: { type: 'internal_error', message: err?.message ?? String(err) } }, 500);
    }
  });

  return app;
}

function toScheduledDeployment(row: ScheduledDeploymentRow) {
  return {
    id: row.id,
    type: 'scheduled_deployment',
    name: row.name,
    agent_id: row.agent_id,
    environment_id: row.environment_id ?? null,
    cron: row.cron,
    timezone: row.timezone || 'UTC',
    payload: parseObject(row.payload),
    status: row.archived_at ? 'archived' : row.status,
    // Read as null when nothing recorded a reason, rather than as an empty object
    // or as `manual`. A row written before M042 is paused with no recorded reason,
    // and reporting `manual` for it would claim the operator's intent was observed
    // when it was not.
    paused_reason: row.paused_reason ? parseObject(row.paused_reason) : null,
    last_run_at: row.last_run_at ?? null,
    next_run_at: row.next_run_at ?? null,
    metadata: parseObject(row.metadata),
    created_at: row.created_at,
    updated_at: row.updated_at,
    archived_at: row.archived_at ?? null,
  };
}

/**
 * The reason recorded for a status, or `null` when the status has none.
 *
 * Every write path derives the reason from the status it is writing rather than
 * setting the two fields separately, so `status` and `paused_reason` cannot
 * disagree — a paused deployment always carries a reason, and an active one never
 * carries a stale one. The same reasoning that put the parked-wait timestamp
 * beside the parked call rather than in a second place.
 *
 * `manual` is the only reason this runtime records. The contract's other kind —
 * an automatic pause after a non-recoverable trigger failure, whose `error.type`
 * is copied from the failed run — belongs with the run-failure taxonomy, so a
 * caller can currently distinguish "paused by a person" from "not paused" but not
 * yet "paused by the runtime" from "paused by a person".
 */
function pauseReasonFor(status: 'active' | 'paused'): string | null {
  return status === 'paused' ? JSON.stringify({ type: 'manual' }) : null;
}

/**
 * The instant an unpaused deployment should next run.
 *
 * The contract is explicit that unpausing resumes "from the next scheduled
 * instant" and that missed triggers are **not** caught up (`定时部署.md:535`).
 * Those two sentences are one rule: while a deployment is paused nothing advances
 * `next_run_at`, so a paused deployment whose slots elapsed still holds a past
 * instant, and leaving it there would make the next due pass fire every missed run
 * — the catch-up the contract forbids.
 *
 * A stored instant that is still in the future is kept as-is. It is already the
 * next scheduled instant, and recomputing it would discard a `next_run_at` the
 * caller set explicitly through the update route.
 *
 * The stored value is parsed rather than compared as a string, because
 * `next_run_at` is caller-supplied and need not carry the same precision or
 * form as `new Date().toISOString()`.
 */
function nextRunAfterResume(row: ScheduledDeploymentRow): string | null {
  const stored = row.next_run_at;
  const storedMs = stored ? Date.parse(stored) : Number.NaN;
  if (Number.isFinite(storedMs) && storedMs > Date.now()) return stored;
  return nextCronRun(row.cron, new Date(), row.timezone || 'UTC')?.toISOString() ?? null;
}

function toScheduledDeploymentRun(row: ScheduledDeploymentRunRow) {
  return {
    id: row.id,
    type: 'scheduled_deployment_run',
    schedule_id: row.schedule_id,
    session_id: row.session_id ?? null,
    status: row.status,
    trigger_type: row.trigger_type,
    payload: parseObject(row.payload),
    error: row.error ?? null,
    started_at: row.started_at,
    completed_at: row.completed_at ?? null,
  };
}

function looksLikeCron(value: string) {
  return value.trim().split(/\s+/).length === 5;
}

type ScheduleFieldsResult =
  | { ok: true; expression: string; timezone: string }
  | { ok: false; message: string };

/**
 * Read the cadence and its zone from either the flat local fields or the
 * canonical object.
 *
 * The published deployments API takes `schedule: { type: 'cron', expression,
 * timezone }`, while this runtime has always taken a flat `cron` string. Both
 * are accepted and resolved to one pair, so a canonical client and an existing
 * local one cannot disagree about what a deployment's cadence is.
 *
 * The zone is validated rather than defaulted: an unknown name would make
 * `nextCronRun` return `null`, and a deployment whose cadence silently stopped
 * resolving looks identical to one that simply has not come due yet.
 */
function parseScheduleFields(value: Record<string, unknown>): ScheduleFieldsResult {
  const nested = value.schedule && typeof value.schedule === 'object' && !Array.isArray(value.schedule)
    ? value.schedule as Record<string, unknown>
    : undefined;
  const expression = stringField(nested?.expression) ?? stringField(value.cron);
  if (!expression) return { ok: false, message: 'cron is required' };
  if (!looksLikeCron(expression)) return { ok: false, message: 'cron must contain five fields' };
  const timezone = stringField(nested?.timezone) ?? stringField(value.timezone) ?? 'UTC';
  if (!isValidTimeZone(timezone)) {
    return { ok: false, message: `timezone must be an IANA time zone identifier (got "${timezone}")` };
  }
  return { ok: true, expression, timezone };
}

function normalizeScheduleStatus(value: unknown): 'active' | 'paused' {
  return value === 'paused' ? 'paused' : 'active';
}

type ScheduledDeploymentRow = {
  id: string;
  name: string;
  agent_id: string;
  environment_id: string | null;
  cron: string;
  timezone: string;
  payload: string;
  status: string;
  paused_reason: string | null;
  last_run_at: string | null;
  next_run_at: string | null;
  metadata: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
};

type ScheduledDeploymentRunRow = {
  id: string;
  schedule_id: string;
  session_id: string | null;
  status: string;
  trigger_type: string;
  payload: string;
  error: string | null;
  started_at: string;
  completed_at: string | null;
};
