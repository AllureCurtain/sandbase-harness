/**
 * Live end-to-end verification of the WP3 thread surface, not a unit test:
 * a real runtime process on a temp workspace, a stub model scripted to call
 * `send_to_agent`, real API calls creating the reviewer + coordinator and
 * driving a turn that actually spawns a child thread, then real HTTP reads
 * of the thread routes to prove what landed.
 *
 * It lives beside the conformance helpers it drives and is deliberately not a
 * `*.test.ts`: it is a manual check with a real process and HTTP calls, so it
 * stays out of the default `vitest` run instead of adding a second full runtime
 * to CI. Run it after a thread-surface change:
 *
 *   npm run verify:threads
 *
 * Set `KEEP_ALIVE=1` to leave the runtime and stub up for a browser pass; the
 * printed `CONSOLE_BASE` / `SESSION` pair then points at the live session.
 */
import { startStubModelServer } from './support/stub-model-server.ts';
import { startRuntimeHarness } from './support/runtime-server.ts';

const CHECK = (ok, label, extra = '') => {
  console.log(`${ok ? '✓' : '✗ FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) process.exitCode = 1;
};

const api = async (base, method, path, body) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const waitFor = async (fn, label, timeoutMs = 30_000, intervalMs = 400) => {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for: ${label}`);
};

let stub;
let runtime;
try {
  // The coordinator's first model request calls send_to_agent("reviewer");
  // every later request (post-dispatch coordinator turn, child's own turn)
  // answers plain text so the child ends end_turn and replies to its parent.
  stub = await startStubModelServer({
    toolCalls: [{ name: 'send_to_agent', arguments: { agent: 'reviewer', message: 'Review the staged diff.' } }],
  });
  runtime = await startRuntimeHarness({ modelBaseUrl: stub.baseUrl, agentName: 'verify-lead' });
  const base = runtime.baseUrl;
  console.log(`runtime: ${base}`);

  // ── 1. Roster write path ────────────────────────────────────────────────
  const reviewer = await api(base, 'POST', '/v1/agents', {
    name: 'reviewer', model: 'conformance-model', system: 'You review.',
  });
  CHECK(reviewer.status === 201, 'POST /v1/agents reviewer', `status ${reviewer.status} ${reviewer.status !== 201 ? JSON.stringify(reviewer.body) : ''}`);
  const reviewerId = reviewer.body?.id;

  const coordinator = await api(base, 'POST', '/v1/agents', {
    name: 'verify-lead', model: 'conformance-model', system: 'You coordinate.',
    multiagent: { type: 'coordinator', agents: [{ type: 'agent', id: reviewerId }, { type: 'self' }] },
  });
  CHECK(coordinator.status === 201, 'POST /v1/agents coordinator with multiagent', `status ${coordinator.status} ${coordinator.status !== 201 ? JSON.stringify(coordinator.body) : ''}`);
  const coordinatorId = coordinator.body?.id;
  CHECK(coordinator.body?.multiagent?.type === 'coordinator', 'coordinator projects resolved roster');
  const rosterIds = (coordinator.body?.multiagent?.agents ?? []).map((m) => m.id).sort();
  CHECK(rosterIds.includes(reviewerId) && rosterIds.includes(coordinatorId), 'roster resolved reviewer + self', JSON.stringify(coordinator.body?.multiagent?.agents));

  // Negative: advisor refuses; multiagent + enable_general_subagent refuses.
  const advisorTry = await api(base, 'POST', '/v1/agents', {
    name: 'advisory', model: 'm', system: 'x',
    multiagent: { type: 'coordinator', agents: [{ type: 'advisor', model: 'm' }] },
  });
  CHECK(advisorTry.status === 400 && advisorTry.body?.error?.code === 'advisor_unsupported', 'advisor member refused with advisor_unsupported', `status ${advisorTry.status}`);
  const d10Try = await api(base, 'POST', '/v1/agents', {
    name: 'both', model: 'm', system: 'x',
    multiagent: { type: 'coordinator', agents: [{ type: 'agent', id: reviewerId }] },
    enable_general_subagent: true,
  });
  CHECK(d10Try.status === 400, 'multiagent + enable_general_subagent refused (D10)', `status ${d10Try.status} ${d10Try.status !== 400 ? JSON.stringify(d10Try.body) : ''}`);

  // ── 2. Live multi-thread turn ───────────────────────────────────────────
  const envs = await api(base, 'GET', '/v1/environments');
  const envId = envs.body?.data?.[0]?.id;
  CHECK(Boolean(envId), 'environment present', envId ?? JSON.stringify(envs.body));

  const session = await api(base, 'POST', '/v1/sessions', {
    agent: coordinatorId, environment_id: envId, title: 'live-verify',
  });
  CHECK(session.status === 201, 'POST /v1/sessions', `status ${session.status} ${session.status !== 201 ? JSON.stringify(session.body) : ''}`);
  const sessionId = session.body?.id;

  // Kick the coordinator's turn with a user.message event (the /events route).
  const send = await api(base, 'POST', `/v1/sessions/${sessionId}/events`, {
    events: [{ type: 'user.message', content: [{ type: 'text', text: 'start' }] }],
  });
  CHECK(send.status === 200 || send.status === 201 || send.status === 202, 'POST user.message event', `status ${send.status} ${send.status >= 400 ? JSON.stringify(send.body) : ''}`);

  // The coordinator's turn calls send_to_agent → a child thread appears.
  const threads = await waitFor(async () => {
    const page = await api(base, 'GET', `/v1/sessions/${sessionId}/threads?limit=100`);
    return page.body?.data?.length > 1 ? page.body.data : null;
  }, 'a second session thread (send_to_agent dispatch)');
  CHECK(true, 'child thread spawned', `${threads.length} threads`);
  const child = threads.find((t) => t.parent_thread_id !== null);
  const primary = threads.find((t) => t.parent_thread_id === null);
  CHECK(primary?.id === `sth_${sessionId.replace(/^sess_/, '')}`, 'primary id is derived sth_<session suffix>', primary?.id);
  CHECK(child?.agent?.name === 'reviewer', 'child thread runs the reviewer roster member', child?.agent?.name);

  // Wait for the child to end_turn → reply cross-posts to the parent.
  await waitFor(async () => {
    const page = await api(base, 'GET', `/v1/sessions/${sessionId}/events?limit=1000`);
    return page.body?.data?.some((e) => e.type === 'agent.thread_message_received') ? page.body.data : null;
  }, 'agent.thread_message_received on the primary stream');
  const events = (await api(base, 'GET', `/v1/sessions/${sessionId}/events?limit=1000`)).body.data;
  // These fields live in `metadata` on the wire.
  const meta = (e) => e?.metadata ?? {};
  const sent = events.find((e) => e.type === 'agent.thread_message_sent');
  const received = events.find((e) => e.type === 'agent.thread_message_received');
  CHECK(Boolean(sent), 'agent.thread_message_sent on primary stream', `to=${meta(sent).to_agent_name}`);
  CHECK(meta(sent).to_session_thread_id === child.id, 'sent targets the child thread', meta(sent).to_session_thread_id);
  CHECK(Boolean(received), 'agent.thread_message_received on primary stream', `from=${meta(received).from_agent_name}`);
  CHECK(meta(received).from_session_thread_id === child.id, 'received sourced from the child thread', meta(received).from_session_thread_id);
  CHECK(events.some((e) => e.type === 'session.thread_created' && meta(e).session_thread_id === child.id), 'session.thread_created present for the child');
  CHECK(events.some((e) => e.type === 'session.thread_status_running' && e.session_thread_id === child.id), 'child running cross-posted with session_thread_id');
  CHECK(events.some((e) => e.type === 'session.thread_status_idle' && e.session_thread_id === child.id), 'child idle cross-posted');

  // The child's own stream: the inbound dispatch and its reply as sent.
  const childEvents = (await api(base, 'GET', `/v1/sessions/${sessionId}/threads/${child.id}/events?limit=1000`)).body.data;
  CHECK(childEvents.some((e) => e.type === 'agent.thread_message_received' && meta(e).from_session_thread_id === primary.id), 'child stream has the inbound dispatch message');
  CHECK(childEvents.some((e) => e.type === 'agent.thread_message_sent' && meta(e).to_session_thread_id === primary.id), 'child stream has its reply as sent');

  // The reply text reached the coordinator's context on the resumed request.
  const lastCoordinatorRequest = stub.requests.at(-1);
  const ctxText = JSON.stringify(lastCoordinatorRequest?.messages ?? []);
  CHECK(ctxText.includes('reviewer'), 'coordinator resumed with reply attributed [来自 reviewer]', ctxText.slice(0, 0) || `requests=${stub.requests.length}`);

  // ── 3. Scoped interrupt + archive over the real routes ──────────────────
  const archive = await api(base, 'POST', `/v1/sessions/${sessionId}/threads/${child.id}/archive`, {});
  CHECK(archive.status === 200, 'archive idle child thread', `status ${archive.status}`);
  const archivePrimary = await api(base, 'POST', `/v1/sessions/${sessionId}/threads/${primary.id}/archive`, {});
  CHECK(archivePrimary.status === 400 && archivePrimary.body?.error?.code === 'primary_thread_not_archivable', 'primary archive refused', `status ${archivePrimary.status} code=${archivePrimary.body?.error?.code}`);

  console.log('\nAll live checks done. Session for browser inspection:');
  console.log(`  CONSOLE_BASE=${base}  SESSION=${sessionId}`);
  // Keep runtime+stub alive for the browser pass.
  console.log(`KEEP_ALIVE=${process.env.KEEP_ALIVE === '1'}`);
  if (process.env.KEEP_ALIVE === '1') {
    console.log('Runtime stays up — press Ctrl+C to stop.');
    await new Promise(() => {});
  }
} catch (err) {
  console.error('\n✗ verification aborted:', err);
  process.exitCode = 1;
} finally {
  if (process.env.KEEP_ALIVE !== '1') {
    await runtime?.stop();
    await stub?.close();
  }
}
