/**
 * Compaction boundaries are per thread.
 *
 * A session's event `seq` is shared by every thread, so a boundary that did
 * not name a thread would truncate the primary and sibling contexts at the
 * child's sequence and inject the child's summary into them. These cases pin
 * the store's scoping and the projection the context builder hands a turn.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '@/core/db/database.js';
import { ContextBuilder } from '@/core/session/context-builder.js';
import { CompactionStore } from '@/core/session/compaction-store.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { primaryThreadIdForSession } from '@/core/session/session-threads.js';
import type { AgentDefinition } from '@/types/agent.js';
import type { Session } from '@/types/session.js';

let directory: string;
let db: Database;
let manager: SessionManager;
let store: CompactionStore;
let session: Session;
let primaryId: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'ma-thread-compaction-'));
  db = new Database(join(directory, 'test.db'));
  db.runMigrations();
  db.exec(`
    INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}');
    INSERT INTO agents (id, name, definition)
    VALUES ('agent_a', 'a', '{"name":"a","model":"m","system":"sys"}');
  `);
  manager = new SessionManager(db);
  store = new CompactionStore(db);
  session = manager.create({ agent: 'agent_a' });
  primaryId = primaryThreadIdForSession(session.id);
});

afterEach(() => {
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

const AGENT: AgentDefinition = { name: 'a', model: 'm', system: 'sys' };

function childThread() {
  return manager.getThreadStore().insertThread({
    sessionId: session.id,
    parentThreadId: primaryId,
    agentName: 'reviewer',
    agentDefinition: { name: 'reviewer', model: 'm', system: 'review' },
    agentId: null,
    agentVersion: null,
    status: 'paused',
  });
}

describe('thread-scoped compaction boundaries', () => {
  it('returns the newest boundary for the requested thread only', () => {
    const child = childThread();
    store.insert({
      sessionId: session.id, threadId: primaryId, summary: 'primary summary',
      eventIdBefore: 'sevt_p', eventSeqBefore: 10, tokensBefore: 100, tokensAfter: 10,
    });
    store.insert({
      sessionId: session.id, threadId: child.id, summary: 'child summary',
      eventIdBefore: 'sevt_c', eventSeqBefore: 20, tokensBefore: 100, tokensAfter: 10,
    });

    expect(store.latest(session.id, primaryId)?.summary).toBe('primary summary');
    expect(store.latest(session.id, child.id)?.summary).toBe('child summary');
    // The unscoped read stays for callers that predate threads and still compact
    // one session-wide stream.
    expect(store.latest(session.id)?.summary).toBe('child summary');
  });

  it('projects each thread with its own summary, never a sibling s', async () => {
    const child = childThread();
    const logger = manager.getEventLogger();
    logger.append(session.id, {
      type: 'user.message',
      threadId: primaryId,
      content: [{ type: 'text', text: 'primary history' }],
    });
    logger.append(session.id, {
      type: 'user.message',
      threadId: child.id,
      content: [{ type: 'text', text: 'child history' }],
    });
    store.insert({
      sessionId: session.id, threadId: primaryId, summary: 'primary summary',
      eventIdBefore: 'sevt_p', eventSeqBefore: 999, tokensBefore: 100, tokensAfter: 10,
    });
    store.insert({
      sessionId: session.id, threadId: child.id, summary: 'child summary',
      eventIdBefore: 'sevt_c', eventSeqBefore: 999, tokensBefore: 100, tokensAfter: 10,
    });

    const builder = new ContextBuilder({ eventLogger: logger, compactionStore: store });
    const event = { type: 'user.message', content: [{ type: 'text', text: 'next' }] } as never;

    const primary = await builder.build(session, AGENT, event, undefined, () => {}, { threadId: primaryId });
    const primaryText = JSON.stringify(primary.messages);
    expect(primaryText).toContain('primary summary');
    expect(primaryText).not.toContain('child summary');

    const childContext = await builder.build(session, AGENT, event, undefined, () => {}, { threadId: child.id });
    const childText = JSON.stringify(childContext.messages);
    expect(childText).toContain('child summary');
    expect(childText).not.toContain('primary summary');
  });
});
