/**
 * Pi RPC session owner: one child, many turns.
 *
 * These tests drive `PiRpcSession` over a fake wire rather than a fake session
 * object, so what is asserted is the path a real turn takes: a prompt is written
 * as one record, the child's frames are translated into durable events, and the
 * turn settles exactly once. Every failure mode asserted here is a case where
 * the runtime must refuse to report success — a turn that ran past its deadline,
 * a child whose stdout ended mid-turn, a dialog nobody can answer — because each
 * of them, if it went the other way, would let a dead engine look healthy.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { SessionEvent } from '@/types/session.js';
import {
  PiRpcDialogUnsupportedError,
  PiRpcSession,
  PiRpcSessionClosedError,
} from '@/strategy/pi/rpc-session.js';
import { PiTimeoutError, PiCleanupPendingError } from '@/strategy/pi-launcher.js';
import { createPiRpcWire, settleAsync, waitFor, type PiRpcWire } from './pi-rpc-test-helpers.js';

const SESSION_ID = 'sess_rpc_owner';

/**
 * A scripted Pi child: answers the commands the runtime writes and lets a test
 * emit exactly the frames it wants, in the order it wants.
 */
class FakePi {
  /** Command names the child received, in order. */
  readonly commands: string[] = [];
  /** Commands deliberately left unanswered, to model a lost outcome. */
  silentCommands = new Set<string>();

  constructor(private readonly wire: PiRpcWire) {
    let buffer = '';
    wire.stdin.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        const index = buffer.indexOf('\n');
        if (index < 0) return;
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.trim()) this.handle(JSON.parse(line) as Record<string, unknown>);
      }
    });
  }

  say(frame: unknown): void {
    this.wire.say(frame);
  }

  private handle(frame: Record<string, unknown>): void {
    const type = String(frame.type);
    this.commands.push(type);
    if (this.silentCommands.has(type)) return;
    this.wire.say({ type: 'response', id: frame.id, command: type, success: true });
  }
}

interface Harness {
  wire: PiRpcWire;
  fake: FakePi;
  events: SessionEvent[];
  broadcasts: SessionEvent[];
  usage: number[][];
  interrupts: number;
  session: PiRpcSession;
}

function harness(options: {
  turnTimeoutMs?: number;
  requestTimeoutMs?: number;
  stderrTail?: () => string;
} = {}): Harness {
  const wire = createPiRpcWire();
  const fake = new FakePi(wire);
  const events: SessionEvent[] = [];
  const broadcasts: SessionEvent[] = [];
  const usage: number[][] = [];
  let sequence = 0;

  const state = {
    wire,
    fake,
    events,
    broadcasts,
    usage,
    interrupts: 0,
  } as Harness;

  const session = new PiRpcSession({
    sessionId: SESSION_ID,
    workDir: '/sandbox/work',
    model: 'fixture-model',
    sessionFile: `/data/pi-sessions/${SESSION_ID}.jsonl`,
    stdin: wire.stdin,
    stdout: wire.stdout,
    stderrTail: options.stderrTail ?? (() => ''),
    // The launcher's abort ladder ends the child, which is what ends its stdout.
    requestInterrupt: async () => {
      state.interrupts += 1;
      wire.end();
    },
    sink: {
      append(_sessionId: string, event: { type: string }) {
        const persisted = {
          id: `sevt_${++sequence}`,
          sessionId: SESSION_ID,
          seq: sequence,
          type: event.type,
          content: (event as { content?: unknown }).content,
          createdAt: new Date(),
        } as unknown as SessionEvent;
        events.push(persisted);
        return persisted;
      },
      getLatestSeq: () => sequence,
      recordUsage: (_sessionId: string, tokensIn: number, tokensOut: number) => usage.push([tokensIn, tokensOut]),
      broadcast: (event: SessionEvent) => broadcasts.push(event),
      spillToolOutput: async (output: string) => output,
    },
    ...(options.turnTimeoutMs ? { turnTimeoutMs: options.turnTimeoutMs } : {}),
    ...(options.requestTimeoutMs ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
  });
  state.session = session;
  session.start();
  return state;
}

/** The frames Pi emits for one text turn that consumes a model request. */
function textTurnFrames(): unknown[] {
  return [
    { type: 'turn_start' },
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'reply' } },
    {
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'reply' }], usage: { input: 2, output: 1 } },
    },
    { type: 'turn_end', message: { role: 'assistant', usage: { input: 2, output: 1 }, stopReason: 'stop' } },
  ];
}

describe('Pi RPC session turns', () => {
  it('writes one prompt as one record and settles the turn on agent_settled', async () => {
    const h = harness();
    await h.session.prompt('run the tests');

    // One frame, one LF-delimited record: nothing else can share the channel.
    expect(h.wire.written).toEqual([
      { id: 'sb-1', type: 'prompt', message: 'run the tests' },
    ]);
    expect(h.session.phase).toBe('busy');
    expect(h.session.turnId).toBe('piturn_1');

    for (const frame of textTurnFrames()) h.fake.say(frame);
    h.fake.say({ type: 'agent_settled' });

    await expect(h.session.awaitTurnOutcome()).resolves.toEqual({ kind: 'settled' });
    expect(h.session.phase).toBe('idle');
    expect(h.session.alive).toBe(true);
  });

  it('translates the turn into durable events, appending each before broadcasting it', async () => {
    const h = harness();
    await h.session.prompt('run');

    for (const frame of textTurnFrames()) h.fake.say(frame);
    h.fake.say({ type: 'agent_settled' });
    await h.session.awaitTurnOutcome();

    expect(h.events.map((event) => event.type)).toEqual([
      'span.model_request_start',
      'agent.message',
      'span.model_request_end',
    ]);
    // The session owner never publishes the terminal marker: the strategy does,
    // after it has decided the turn actually settled.
    expect(h.events.map((event) => event.type)).not.toContain('turn_complete');
    // Persist before broadcast: a live subscriber must never see an event the
    // log does not already hold.
    const durableBroadcasts = h.broadcasts.filter((event) => event.seq > 0).map((event) => event.id);
    expect(durableBroadcasts).toEqual(h.events.map((event) => event.id));
    // Text deltas stay live-only: they are broadcast as `seq: 0` stream frames
    // and are not replay authority.
    expect(h.broadcasts.filter((event) => event.seq === 0).map((event) => event.type)).toEqual([
      'agent.message_stream_start', 'agent.message_chunk', 'agent.message_stream_end',
    ]);
    // Exactly one usage record for the one model request of this turn.
    expect(h.usage).toEqual([[2, 1]]);
  });

  it('refuses a second turn while one is in flight instead of interleaving two prompts', async () => {
    const h = harness();
    await h.session.prompt('first');

    await expect(h.session.prompt('second')).rejects.toMatchObject({
      name: 'PiRpcSessionClosedError',
      code: 'pi_rpc_session_closed',
    });
    expect(h.wire.written).toHaveLength(1);
    expect(h.fake.commands).toEqual(['prompt']);
  });

  it('reports a turn Pi failed with the error Pi produced', async () => {
    const h = harness();
    await h.session.prompt('run');
    h.fake.say({ type: 'error', message: 'model not found: sandbase/nope' });
    h.fake.say({ type: 'agent_settled' });

    const outcome = await h.session.awaitTurnOutcome();
    expect(outcome.kind).toBe('failed');
    expect(outcome.kind === 'failed' && outcome.error.message).toContain('model not found: sandbase/nope');
  });

  it('settles a turn once, and a repeated end-of-turn frame settles no later turn', async () => {
    const h = harness();
    await h.session.prompt('run');
    h.fake.say({ type: 'agent_settled' });
    await expect(h.session.awaitTurnOutcome()).resolves.toEqual({ kind: 'settled' });

    // A duplicate frame arrives while no turn is armed. It must not be buffered
    // and reported as the outcome of the turn that starts afterwards.
    h.fake.say({ type: 'agent_settled' });
    await settleAsync();
    await h.session.prompt('again');
    expect(h.session.turnId).toBe('piturn_2');
    expect(h.session.phase).toBe('busy');

    h.fake.say({ type: 'agent_settled' });
    await expect(h.session.awaitTurnOutcome()).resolves.toEqual({ kind: 'settled' });
  });

  it('refuses to await a turn that was never armed', async () => {
    const h = harness();

    await expect(h.session.awaitTurnOutcome()).rejects.toBeInstanceOf(PiRpcSessionClosedError);
  });

  it('fails a turn that outlives its deadline and cancels the wedged child', async () => {
    const h = harness({ turnTimeoutMs: 30 });
    await h.session.prompt('run');
    // Pi never settles the turn, so only the deadline can end it.
    const outcome = await h.session.awaitTurnOutcome();

    // Acceptance: the deadline publishes the outcome the runtime already has
    // for a Pi turn past its deadline, rather than leaving the caller waiting.
    expect(outcome.kind).toBe('failed');
    expect(outcome.kind === 'failed' && outcome.error).toBeInstanceOf(PiTimeoutError);
    expect(outcome.kind === 'failed' && outcome.error).toMatchObject({
      name: 'PiTimeoutError',
      code: 'pi_timed_out',
    });
    // The child is asked to stop and then released, so the next turn cannot
    // inherit an engine that is still inside the turn the runtime gave up on.
    await waitFor(() => h.interrupts === 1, 'the wedged child to be released');
    expect(h.fake.commands).toContain('abort');
    expect(h.session.phase).toBe('closed');
    expect(h.session.alive).toBe(false);
    expect(h.session.failureError?.message).toContain('timed out after 30ms');
    await expect(h.session.prompt('again')).rejects.toThrow(/timed out after 30ms/);
  });

  it('fails the turn that was in flight when the child exits, and carries the reason', async () => {
    const h = harness();
    await h.session.prompt('run');
    h.wire.end();

    const outcome = await h.session.awaitTurnOutcome();
    expect(outcome.kind).toBe('failed');
    expect(outcome.kind === 'failed' && outcome.error).toMatchObject({
      name: 'PiRpcSessionClosedError',
      code: 'pi_rpc_session_closed',
    });
    expect(h.session.alive).toBe(false);
    // Acceptance: no later turn reports success, and the refusal names why.
    await expect(h.session.prompt('again')).rejects.toThrow(/stdout ended/);
    expect(h.wire.written).toHaveLength(1);
  });

  it('reports a resume Pi refused as a continuity failure, not as a crash', async () => {
    const h = harness({
      stderrTail: () => 'Stored session working directory does not exist: /gone/workspace',
    });
    await h.session.prompt('run');
    h.wire.end();

    const outcome = await h.session.awaitTurnOutcome();
    expect(outcome.kind).toBe('failed');
    // "stdout ended" would leave the operator unable to tell a refused resume
    // from a crash, and the two call for opposite responses.
    expect(outcome.kind === 'failed' && outcome.error).toMatchObject({
      name: 'PiContinuityError',
      code: 'pi_resume_refused',
    });
  });

  it('fails a blocking dialog this runtime cannot answer instead of leaving Pi waiting', async () => {
    const h = harness();
    await h.session.prompt('run');
    h.fake.say({ type: 'extension_ui_request', id: 'ui-1', method: 'confirm', message: 'Proceed?' });

    const outcome = await h.session.awaitTurnOutcome();
    expect(outcome.kind).toBe('failed');
    expect(outcome.kind === 'failed' && outcome.error).toBeInstanceOf(PiRpcDialogUnsupportedError);
    // The session is no longer usable, so the strategy releases the child rather
    // than waiting on a decision nobody can produce.
    expect(h.session.alive).toBe(false);
    expect(h.session.phase).toBe('closed');
    // Nothing is ever written on the dialog channel: inventing a reply would be
    // a decision this runtime has no basis for.
    expect(h.wire.written.map((frame) => frame.type)).not.toContain('extension_ui_response');
    await expect(h.session.prompt('again')).rejects.toThrow(/dialog/);
  });

  it('ignores a fire-and-forget extension notification', async () => {
    const h = harness();
    await h.session.prompt('run');
    h.fake.say({ type: 'extension_ui_request', id: 'ui-1', method: 'notify', message: 'working' });
    await settleAsync();

    // The turn is still running: a notification is not a decision to answer and
    // not an end-of-turn marker.
    expect(h.session.phase).toBe('busy');
    h.fake.say({ type: 'agent_settled' });
    await expect(h.session.awaitTurnOutcome()).resolves.toEqual({ kind: 'settled' });
  });
});

describe('Pi RPC session release', () => {
  it('closes the child and releases its work directory, once', async () => {
    const h = harness();
    await h.session.prompt('run');
    h.fake.say({ type: 'agent_settled' });
    await h.session.awaitTurnOutcome();

    await h.session.close();
    expect(h.interrupts).toBe(1);
    expect(h.session.alive).toBe(false);
    expect(h.session.phase).toBe('closed');

    // Idempotent: stop, delete and close can each ask for the same release.
    await h.session.close();
    expect(h.interrupts).toBe(1);
  });

  it('releases the child when the session is closed mid-turn', async () => {
    const h = harness();
    await h.session.prompt('run');

    await h.session.close();

    // The turn that was in flight settles as failed rather than hanging: the
    // caller is waiting on an outcome that must exist.
    const outcome = await h.session.awaitTurnOutcome();
    expect(outcome.kind).toBe('failed');
    expect(h.interrupts).toBe(1);
  });

  it('reports a retained workspace instead of claiming the child was released', async () => {
    const wire = createPiRpcWire();
    const fake = new FakePi(wire);
    const cleanup = new PiCleanupPendingError('Pi process tree cleanup is pending; the workspace remains retained');
    const session = new PiRpcSession({
      sessionId: SESSION_ID,
      workDir: '/sandbox/work',
      model: 'fixture-model',
      stdin: wire.stdin,
      stdout: wire.stdout,
      stderrTail: () => '',
      requestInterrupt: async () => { throw cleanup; },
      sink: {
        append: (_sessionId, event) => ({ id: 'sevt_1', sessionId: SESSION_ID, seq: 1, type: event.type, createdAt: new Date() } as unknown as SessionEvent),
        getLatestSeq: () => 0,
        recordUsage: () => {},
        broadcast: () => {},
        spillToolOutput: async (output) => output,
      },
    });
    session.start();
    await session.prompt('run');

    // A cleanup failure is an ownership failure, so it is thrown rather than
    // reported as a clean stop: the runtime must not release a workspace a
    // child may still hold.
    await expect(session.close()).rejects.toBeInstanceOf(PiCleanupPendingError);
    expect(fake.commands).toEqual(['prompt']);
  });
});
