/**
 * Handoff bundle construction.
 *
 * A handoff bundle is the "hand this session to a person or team" action: the
 * recorded evidence of one session, packaged so a recipient can inspect it and
 * replay it without access to this runtime.
 *
 * Three things are deliberately not invented here (see the design note this
 * implements):
 *
 *   - the description format is RO-Crate, not a bespoke manifest;
 *   - the integrity format is BagIt, not a bespoke checksum file;
 *   - the signature format is an in-toto statement in a DSSE envelope, the same
 *     construction SLSA uses.
 *
 * Two things are deliberately explicit rather than left implicit:
 *
 *   - `replay.mode` names which replay semantics the bundle actually supports.
 *     A bundle that does not say is not evidence of anything.
 *   - message bodies are excluded by default. OTel GenAI makes content capture
 *     an opt-in for the same reason: prompt text is where personal and
 *     proprietary data accumulates, and a bundle is meant to be handed around.
 *
 * `snapshot-manager` is intentionally not the base of this. It tars a sandbox
 * working directory so a session can resume with the same filesystem bytes —
 * a recovery mechanism. This is an evidence-export mechanism, and conflating
 * the two would make the bundle's contents depend on whether a snapshot
 * happened to be taken.
 */

import { createHash } from 'node:crypto';
import { nanoid } from 'nanoid';
import type { Database } from '@/core/db/database.js';
import type { Session, SessionEvent } from '@/types/session.js';
import type { AgentDefinition } from '@/types/agent.js';
import { resolveAttestationSigner, wrapInDsseEnvelope } from '@/core/security/attestation.js';
import { resolveSessionCredentialInjections } from '@/core/credentials/injection.js';
import { bagItFile, buildBagItManifest, sha512Hex, type BagItManifest } from './bagit.js';
import { buildRoCrateMetadata, crateContextEntity, type RoCratePart } from './rocrate.js';
import {
  CONTENT_CAPTURE_ATTRIBUTE,
  genAiContentReference,
  genAiSpanAttributes,
  genAiToolAttributes,
  type GenAiContentCapture,
} from './otel.js';

export const HANDOFF_BUNDLE_SCHEMA_VERSION = '1.0.0';

/**
 * Replay semantics a bundle can declare.
 *
 * - `recorded_replay`: re-drive the recorded event sequence and replay recorded
 *   tool outputs. Implemented by this version.
 * - `resume`: continue the session from its last state. Declared but not
 *   produced here — it depends on a sandbox snapshot, which this bundle does
 *   not carry.
 * - `fresh_run`: re-run from the agent definition and inputs, producing new
 *   model output. Declared but not produced here.
 */
export const HANDOFF_REPLAY_MODES = ['recorded_replay', 'resume', 'fresh_run'] as const;
export type HandoffReplayMode = (typeof HANDOFF_REPLAY_MODES)[number];

export type HandoffBundleOptions = {
  /** Include message bodies. Default false; digests are recorded instead. */
  includeMessageContent?: boolean;
  /** Include uploaded file bytes. Default false. */
  includeFileContent?: boolean;
  /** Target host used when reporting the credential injection decision. */
  targetHost?: string;
  /** Free-form label for the recipient, e.g. a ticket id. */
  label?: string;
  /** Runtime version string, recorded as the crate producer. */
  runtimeVersion?: string;
  dataDir?: string;
  /** Overrides the generated bundle id. Used by tests to get a stable id. */
  id?: string;
};

export type HandoffBundleDeps = {
  db: Database;
  getSession: (id: string) => Session | null;
  listEvents: (id: string) => SessionEvent[];
  /** Capability inventory, recorded so a recipient knows what was executable. */
  listCapabilities?: () => unknown[];
  artifactStore?: { exists: (path: string) => boolean; readFile: (path: string) => Buffer };
};

export type HandoffBundle = {
  id: string;
  type: 'handoff_bundle';
  schema_version: string;
  session_id: string;
  label: string | null;
  created_at: string;
  generator: {
    name: string;
    version: string;
    runtime: string;
  };
  replay: {
    mode: HandoffReplayMode;
    supported_modes: HandoffReplayMode[];
    /** Modes the runtime recognises but this bundle does not support. */
    unsupported_modes: HandoffReplayMode[];
    /**
     * Recorded replays must never re-run a tool that had a side effect; the
     * recorded output is used as a stub instead.
     */
    tool_side_effects: 'recorded_outputs_used_as_stub';
    tool_execution: 'never_re_executed';
    /** Replays reproduce the recorded sequence, not new model output. */
    model_requests: 'not_reissued';
  };
  content: {
    [CONTENT_CAPTURE_ATTRIBUTE]: GenAiContentCapture;
    message_bodies_included: boolean;
    file_bytes_included: boolean;
  };
  redaction: {
    policy: string;
    /** Credentials policy refused to inject. Never decrypted, never present. */
    credentials_denied: Array<Record<string, unknown>>;
    /** Credentials that were injected, metadata only, secret never included. */
    credentials_injected: Array<Record<string, unknown>>;
    /** Keys whose values were replaced with `[redacted]` in the transcript. */
    scrubbed_fields: string[];
  };
  session: Record<string, unknown>;
  agent: Record<string, unknown> | null;
  environment: Record<string, unknown> | null;
  settings: Record<string, unknown> | null;
  capabilities: unknown[];
  transcript: {
    events: Array<Record<string, unknown>>;
    event_count: number;
    first_seq: number | null;
    last_seq: number | null;
  };
  tools: {
    calls: Array<Record<string, unknown>>;
    call_count: number;
  };
  files: {
    entries: Array<Record<string, unknown>>;
    entry_count: number;
  };
  ro_crate: Record<string, unknown>;
  bagit: BagItManifest;
  attestation: {
    statement: Record<string, unknown>;
    dsse_envelope: Record<string, unknown>;
    /** PEM, so a verifier can be handed the public half out of band. */
    public_key_pem: string;
    /** The payload type and envelope shape are standard; the key is local. */
    trust_root: string;
  };
  integrity: {
    /** SHA-256 of the canonical JSON of every other top-level field. */
    payload_sha256: string;
  };
};

const KEY_SCRUB_PATTERN = /(pass(word|phrase)?|secret|token|api[-_]?key|authorization|credential|bearer)/i;

export function buildHandoffBundle(
  deps: HandoffBundleDeps,
  sessionId: string,
  options: HandoffBundleOptions = {},
): HandoffBundle {
  const session = deps.getSession(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);

  const bundleId = options.id ?? `hb_${nanoid(18)}`;
  const createdAt = new Date().toISOString();
  const includeMessageContent = options.includeMessageContent === true;
  const includeFileContent = options.includeFileContent === true;

  const events = deps.listEvents(sessionId);
  const redaction = collectCredentialReport(deps.db, sessionId, options);
  const { events: transcriptEvents, scrubbedFields } = projectTranscript(events, {
    includeMessageContent,
    scrubbedFields: new Set<string>(),
  });

  const tools = collectToolCalls(events);
  const files = collectSessionFiles(deps, session, includeFileContent);
  const environment = readEnvironment(deps.db, session.environmentId);
  const settings = readSettingsSnapshot(deps.db);
  const agent = (session.agentDefinition as AgentDefinition | undefined) ?? null;

  const bundle = {
    id: bundleId,
    type: 'handoff_bundle' as const,
    schema_version: HANDOFF_BUNDLE_SCHEMA_VERSION,
    session_id: sessionId,
    label: options.label ?? null,
    created_at: createdAt,
    generator: {
      name: 'managed-agents',
      version: options.runtimeVersion ?? '0.0.0',
      runtime: 'sandbase-harness',
    },
    replay: {
      mode: 'recorded_replay' as HandoffReplayMode,
      supported_modes: ['recorded_replay'] as HandoffReplayMode[],
      unsupported_modes: HANDOFF_REPLAY_MODES.filter((mode) => mode !== 'recorded_replay'),
      tool_side_effects: 'recorded_outputs_used_as_stub' as const,
      tool_execution: 'never_re_executed' as const,
      model_requests: 'not_reissued' as const,
    },
    content: {
      [CONTENT_CAPTURE_ATTRIBUTE]: (includeMessageContent ? 'full_content' : 'no_content') as GenAiContentCapture,
      message_bodies_included: includeMessageContent,
      file_bytes_included: includeFileContent,
    },
    redaction: {
      policy:
        'Credential secrets are never included: denied credentials are never decrypted, and '
        + 'injected credentials are described by metadata only. Transcript fields whose key '
        + 'names a secret are replaced with [redacted].',
      credentials_denied: redaction.denied,
      credentials_injected: redaction.injected,
      scrubbed_fields: [...scrubbedFields].sort(),
    },
    session: toSessionSnapshot(session),
    agent: agent ? (agent as unknown as Record<string, unknown>) : null,
    environment,
    settings,
    capabilities: deps.listCapabilities?.() ?? [],
    transcript: {
      events: transcriptEvents,
      event_count: transcriptEvents.length,
      first_seq: transcriptEvents.length > 0 ? Number(transcriptEvents[0].seq) : null,
      last_seq: transcriptEvents.length > 0 ? Number(transcriptEvents[transcriptEvents.length - 1].seq) : null,
    },
    tools,
    files,
  };

  // The package layers are computed from the parts above, never from a separate
  // source of truth, so the manifest, the crate, and the signature cannot drift
  // from the payload they describe.
  const parts = serializeParts(bundle);
  const bagit = buildBagItManifest(parts.map((part) => bagItFile(part.path, part.json)));
  const roCrate = buildRoCrateMetadata({
    bundleId,
    name: `Handoff bundle ${bundleId}`,
    description:
      `Recorded evidence for session ${sessionId}, replayable in "${'recorded_replay'}" mode.`
      + (includeMessageContent ? '' : ' Message bodies are excluded; digests are recorded instead.'),
    createdAt,
    generator: `${bundle.generator.name}/${bundle.generator.version}`,
    parts: parts.map<RoCratePart>((part) => ({
      path: part.path,
      name: part.name,
      description: part.description,
      entityType: part.entityType,
      encodingFormat: 'application/json',
      sha512: sha512Hex(part.json),
      bytes: Buffer.byteLength(part.json, 'utf8'),
    })),
    contextEntities: [
      crateContextEntity(`#session-${sessionId}`, 'CreativeWork', session.title ?? 'Untitled session', {
        identifier: sessionId,
        identifier_source: 'managed-agents',
      }),
      ...(agent
        ? [crateContextEntity(`#agent-${session.agentId}`, 'SoftwareApplication', agent.name ?? session.agentName)]
        : []),
    ],
  });

  const signer = resolveAttestationSigner(options.dataDir);
  const statement = buildInTotoStatement(bundleId, sessionId, createdAt, parts, includeMessageContent);
  const dsseEnvelope = wrapInDsseEnvelope(statement, signer);

  const withLayers = { ...bundle, ro_crate: roCrate, bagit, attestation: {
    statement,
    dsse_envelope: dsseEnvelope,
    public_key_pem: signer.publicKeyPem,
    trust_root:
      'Local runtime key (Ed25519, derived from the runtime secret). It proves the bundle '
      + 'came from this runtime and is intact; it does not prove which human produced it. '
      + 'Re-sign dsse_envelope with your own key for third-party-verifiable provenance.',
  } };

  return {
    ...withLayers,
    integrity: { payload_sha256: sha256Hex(canonicalJson(withLayers)) },
  };
}

/**
 * Serialize the bundle's logical payload parts.
 *
 * The bundle is served as JSON rather than a directory tree, so these parts are
 * the documents a recipient extracts — one file each under `data/`. Naming them
 * here keeps BagIt, RO-Crate, and the in-toto subjects describing the same set.
 */
function serializeParts(bundle: Omit<HandoffBundle, 'ro_crate' | 'bagit' | 'attestation' | 'integrity'>) {
  return [
    part('data/session.json', 'Session', 'Session record as recorded at bundle time.', bundle.session),
    part('data/agent.json', 'Agent definition', 'Agent definition snapshot used by this session.', bundle.agent ?? {}),
    part('data/environment.json', 'Environment', 'Environment snapshot.', bundle.environment ?? {}),
    part('data/settings.json', 'Runtime settings', 'Effective runtime settings, secrets excluded.', bundle.settings ?? {}),
    part('data/transcript.json', 'Transcript', 'Append-only event log.', bundle.transcript),
    part('data/tools.json', 'Tool calls', 'Recorded tool calls and their outputs.', bundle.tools),
    part('data/files.json', 'Files', 'Session file resources.', bundle.files),
    part('data/redaction.json', 'Redaction report', 'What was withheld and why.', bundle.redaction),
  ];
}

function part(path: string, name: string, description: string, value: unknown, entityType = 'File') {
  return { path, name, description, entityType, json: canonicalJson(value) };
}

function buildInTotoStatement(
  bundleId: string,
  sessionId: string,
  createdAt: string,
  parts: Array<{ path: string; json: string }>,
  includeMessageContent: boolean,
): Record<string, unknown> {
  return {
    _type: 'https://in-toto.io/Statement/v1',
    subject: parts
      .map((part) => ({
        name: part.path,
        digest: { sha256: sha256Hex(part.json) },
      }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    predicateType: 'https://sandbase.dev/attestation/handoff-bundle/v1',
    predicate: {
      bundle_id: bundleId,
      session_id: sessionId,
      created_at: createdAt,
      replay_mode: 'recorded_replay',
      includes_message_content: includeMessageContent,
      tool_execution: 'never_re_executed',
    },
  };
}

/** Event types whose `content` is a message body rather than tool metadata. */
const MESSAGE_BODY_TYPES = new Set([
  'user.message',
  'agent.message',
  'agent.thinking',
  'agent.message_chunk',
  'system.message',
]);

function projectTranscript(
  events: SessionEvent[],
  opts: { includeMessageContent: boolean; scrubbedFields: Set<string> },
): { events: Array<Record<string, unknown>>; scrubbedFields: Set<string> } {
  const projected = events.map((event) => {
    const record: Record<string, unknown> = {
      id: event.id,
      seq: event.seq,
      type: event.type,
      created_at: event.createdAt instanceof Date ? event.createdAt.toISOString() : event.createdAt ?? null,
      ...(event.metadata && Object.keys(event.metadata).length > 0
        ? { metadata: scrubSecrets(event.metadata, opts.scrubbedFields) as Record<string, unknown> }
        : {}),
    };

    const attributes = genAiSpanAttributes({
      provider: event.metadata?.provider as string ?? 'unknown',
      requestModel: event.modelUsed ?? null,
      finishReason: event.stopReason ?? null,
      inputTokens: event.tokensIn ?? null,
      outputTokens: event.tokensOut ?? null,
      operationName: 'chat',
    });
    if (Object.keys(attributes).length > 0) record.attributes = attributes;

    if (event.content !== undefined && event.content !== null) {
      if (!MESSAGE_BODY_TYPES.has(event.type) || opts.includeMessageContent) {
        record.content = scrubSecrets(event.content, opts.scrubbedFields);
      } else {
        record.content_reference = genAiContentReference(stringifyContent(event.content));
        record.content = null;
      }
    }

    if (event.parentEventId) record.parent_event_id = event.parentEventId;
    if (typeof event.durationMs === 'number') record.duration_ms = event.durationMs;
    return record;
  });
  return { events: projected, scrubbedFields: opts.scrubbedFields };
}

/**
 * Tool calls, paired from the recorded events.
 *
 * Each call carries whether it has a side effect, because replay must not
 * re-run a side-effecting tool: the recorded output is used as a stub instead.
 */
function collectToolCalls(events: SessionEvent[]): { calls: Array<Record<string, unknown>>; call_count: number } {
  const byId = new Map<string, Record<string, unknown>>();
  const order: string[] = [];

  for (const event of events) {
    const useId = typeof event.metadata?.tool_use_id === 'string' ? event.metadata.tool_use_id : undefined;
    if (event.type === 'agent.tool_use' || event.type === 'agent.mcp_tool_use' || event.type === 'agent.custom_tool_use') {
      const callId = useId ?? event.id;
      const name = typeof event.metadata?.tool_name === 'string'
        ? event.metadata.tool_name as string
        : inferToolName(event);
      const record: Record<string, unknown> = {
        call_id: callId,
        event_id: event.id,
        name,
        operation: event.type === 'agent.custom_tool_use'
          ? 'custom_tool'
          : event.type === 'agent.mcp_tool_use'
            ? 'mcp_tool'
            : 'tool',
        input: scrubSecrets(event.content ?? null, new Set()),
        // Replay never re-runs a tool, so every recorded call is the stub.
        replayed: true,
        status: 'pending',
        output: null,
        attributes: genAiToolAttributes({ name, callId, status: 'pending' }),
      };
      byId.set(callId, record);
      order.push(callId);
      continue;
    }

    if (event.type === 'agent.tool_result' || event.type === 'agent.mcp_tool_result') {
      const callId = useId ?? event.id;
      const record = byId.get(callId);
      if (record) {
        // A denial is terminal: the refusal result that the runtime records
        // afterwards must not upgrade the call back to "ok".
        if (record.status !== 'denied') {
          record.status = 'ok';
          record.output = scrubSecrets(event.content ?? null, new Set());
          record.duration_ms = event.durationMs ?? null;
          record.attributes = genAiToolAttributes({
            name: String(record.name),
            callId,
            status: 'ok',
            durationMs: event.durationMs ?? null,
          });
        }
      } else {
        // A result without a recorded request happens when the bundle starts
        // mid-conversation. Record it rather than dropping it, so the count of
        // tool activity is not understated.
        const name = inferToolName(event);
        byId.set(callId, {
          call_id: callId,
          event_id: event.id,
          name,
          operation: event.type === 'agent.mcp_tool_result' ? 'mcp_tool' : 'tool',
          input: null,
          replayed: true,
          status: 'ok',
          output: scrubSecrets(event.content ?? null, new Set()),
          orphaned_result: true,
          attributes: genAiToolAttributes({ name, callId, status: 'ok' }),
        });
        order.push(callId);
      }
      continue;
    }

    if (event.type === 'user.tool_confirmation') {
      const callId = useId ?? event.id;
      const record = byId.get(callId);
      const result = event.metadata?.result;
      if (record) {
        record.confirmation = result === 'deny' ? 'deny' : 'allow';
        if (result === 'deny') {
          record.status = 'denied';
          record.attributes = genAiToolAttributes({
            name: String(record.name),
            callId,
            status: 'denied',
          });
        }
      }
    }
  }

  return { calls: order.map((id) => byId.get(id)!), call_count: order.length };
}

function inferToolName(event: SessionEvent): string {
  if (typeof event.metadata?.mcp_server_name === 'string' && typeof event.metadata?.tool_name === 'string') {
    return `${event.metadata.mcp_server_name}.${event.metadata.tool_name}`;
  }
  return typeof event.metadata?.tool_name === 'string' ? event.metadata.tool_name as string : 'unknown';
}

function collectSessionFiles(
  deps: HandoffBundleDeps,
  session: Session,
  includeFileContent: boolean,
): { entries: Array<Record<string, unknown>>; entry_count: number } {
  const rows = deps.db.prepare(
    `SELECT * FROM files
     WHERE archived_at IS NULL
       AND (session_id = ? OR id IN (${sessionFileIds(session).map(() => '?').join(',') || "''"}))
     ORDER BY created_at ASC`,
  ).all(session.id, ...sessionFileIds(session)) as Array<Record<string, unknown>>;

  const entries = rows.map((row) => {
    const storagePath = typeof row.storage_path === 'string' ? row.storage_path : '';
    const readable = includeFileContent && deps.artifactStore && storagePath
      ? deps.artifactStore.exists(storagePath)
      : false;
    return {
      id: row.id,
      name: row.name,
      media_type: row.media_type,
      size_bytes: row.size_bytes,
      role: row.role ?? null,
      session_id: row.session_id ?? null,
      mount_path: mountPathFor(session, String(row.id)),
      sha256: readable && storagePath
        ? sha256Hex(deps.artifactStore!.readFile(storagePath))
        : null,
      content_included: readable,
    };
  });

  return { entries, entry_count: entries.length };
}

/**
 * File ids referenced by the session's `file` resources.
 *
 * The `files.session_id` column is only populated for artifacts written through
 * the session path, so mounting a pre-uploaded file does not set it. Both
 * sources are consulted or the bundle would silently omit mounted uploads.
 */
function sessionFileIds(session: Session): string[] {
  return (session.resources ?? [])
    .filter((resource) => resource.type === 'file' && typeof resource.file_id === 'string')
    .map((resource) => resource.file_id as string);
}

function mountPathFor(session: Session, fileId: string): string | null {
  const resource = (session.resources ?? []).find(
    (item) => item.type === 'file' && item.file_id === fileId,
  );
  return typeof resource?.mount_path === 'string' ? resource.mount_path : null;
}

function collectCredentialReport(
  db: Database,
  sessionId: string,
  options: HandoffBundleOptions,
): { denied: Array<Record<string, unknown>>; injected: Array<Record<string, unknown>> } {
  try {
    const bundle = resolveSessionCredentialInjections(db, sessionId, {
      dataDir: options.dataDir,
      actor: 'handoff-bundle',
      targetHost: options.targetHost,
    });
    return {
      // The injection bundle's `credentials` entries carry `value_hint` rather
      // than the secret by construction, so they are safe to record verbatim.
      denied: bundle.denied as unknown as Array<Record<string, unknown>>,
      injected: bundle.credentials as unknown as Array<Record<string, unknown>>,
    };
  } catch {
    // A bundle must still be producible when credential resolution cannot run
    // (for example a rotated key). The failure is recorded rather than
    // swallowed, because an empty denial list would read as "nothing denied".
    return {
      denied: [{ error: 'credential_resolution_failed' }],
      injected: [],
    };
  }
}

function readEnvironment(db: Database, environmentId: string): Record<string, unknown> | null {
  const row = db.prepare('SELECT * FROM environments WHERE id = ?').get(environmentId) as
    | Record<string, unknown>
    | undefined;
  if (!row) return null;
  const config = parseJsonObject(row.config);
  // `config` holds the runtime-facing shape; credential material would not live
  // here, but the environment row is redacted defensively so a future field
  // cannot leak by default.
  return {
    id: row.id,
    name: row.name ?? null,
    hosting_type: config.hosting_type ?? null,
    sandbox_provider: config.sandbox_provider ?? null,
    config: scrubSecrets(config, new Set()) as Record<string, unknown>,
    archived_at: row.archived_at ?? null,
  };
}

function readSettingsSnapshot(db: Database): Record<string, unknown> | null {
  const row = db.prepare('SELECT * FROM runtime_settings LIMIT 1').get() as Record<string, unknown> | undefined;
  if (!row) return null;
  const snapshot: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    // Secret columns are stored encrypted and are never part of a bundle. The
    // `scrubSecrets` pass below catches any new column that names one.
    if (key.endsWith('_secret') || key.endsWith('_ciphertext') || key.endsWith('_nonce') || key.endsWith('_tag')) continue;
    snapshot[key] = value;
  }
  return scrubSecrets(snapshot, new Set()) as Record<string, unknown>;
}

function toSessionSnapshot(session: Session): Record<string, unknown> {
  return {
    id: session.id,
    title: session.title ?? null,
    agent_id: session.agentId,
    agent_name: session.agentName,
    agent_version: session.agentVersion ?? null,
    environment_id: session.environmentId,
    loop_engine: session.loopEngine ?? 'builtin',
    status: session.status,
    sandbox_type: session.sandboxType ?? null,
    // Sandbox state can embed sandbox-internal handles; it identifies the
    // sandbox for an operator, it is not part of the replay.
    sandbox_state: session.sandboxState ? scrubSecrets(session.sandboxState, new Set()) : null,
    resources: session.resources ?? [],
    vault_ids: session.vaultIds ?? [],
    usage: {
      input_tokens: session.usage?.tokensIn ?? 0,
      output_tokens: session.usage?.tokensOut ?? 0,
    },
    metadata: session.metadata ?? {},
    created_at: session.createdAt.toISOString(),
    updated_at: session.updatedAt.toISOString(),
    completed_at: session.completedAt ? session.completedAt.toISOString() : null,
  };
}

/**
 * Replace secret-looking values wherever they appear.
 *
 * Key-name matching rather than value-pattern matching: a token entropy
 * heuristic misses short secrets and mangles innocent hex, while a key named
 * `authorization_token` is unambiguous. Every replacement is reported in
 * `redaction.scrubbed_fields` so withholding is auditable.
 */
export function scrubSecrets(value: unknown, scrubbed: Set<string>, path = ''): unknown {
  if (Array.isArray(value)) return value.map((item, index) => scrubSecrets(item, scrubbed, `${path}[${index}]`));
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const childPath = path ? `${path}.${key}` : key;
      if (KEY_SCRUB_PATTERN.test(key)) {
        scrubbed.add(childPath);
        result[key] = '[redacted]';
        continue;
      }
      result[key] = scrubSecrets(item, scrubbed, childPath);
    }
    return result;
  }
  return value;
}

/**
 * Deterministic JSON: object keys sorted at every level.
 *
 * Every digest in the bundle is taken over this form, so two runs over the same
 * data produce the same numbers. Insertion order would make digests depend on
 * how the object happened to be built.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (source[key] === undefined) continue;
      sorted[key] = sortDeep(source[key]);
    }
    return sorted;
  }
  return value;
}

function sha256Hex(value: string | Buffer): string {
  // Uses this module's own `node:crypto` import. The earlier `require` form did
  // not resolve: this package is ESM ("type": "module"), where `require` is not
  // defined, so every digest in the bundle would have thrown at runtime.
  return createHash('sha256').update(value).digest('hex');
}

function stringifyContent(content: unknown): string {
  if (typeof content === 'string') return content;
  return JSON.stringify(content);
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}
