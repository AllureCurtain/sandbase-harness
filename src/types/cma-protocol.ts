/**
 * CMA Protocol Event Types
 *
 * Complete type definitions for the Claude Managed Agents protocol events.
 * Source of truth: Anthropic CMA event specification.
 *
 * Event types use dot notation, grouped by namespace:
 * - user.*      — Events sent by the client to the session
 * - agent.*     — Events emitted by the agent during execution
 * - session.*   — Session lifecycle status events
 * - span.*      — Observability spans (model request timing)
 */

// ============================================================
// Event Type Enum
// ============================================================

/**
 * All possible CMA event types.
 * 7 user (incl. `user.define_outcome` and `user.steer`) + 8 agent + 5 streaming + 7 session + 5 span + 1 terminal = 33 total
 */
export type CMAEventType =
  // User events (7)
  | 'system.message'
  | 'user.message'
  | 'user.interrupt'
  | 'user.tool_confirmation'
  | 'user.custom_tool_result'
  | 'user.define_outcome'
  | 'user.steer'
  // Agent events (8)
  | 'agent.message'
  | 'agent.thinking'
  | 'agent.tool_use'
  | 'agent.tool_result'
  | 'agent.mcp_tool_use'
  | 'agent.mcp_tool_result'
  | 'agent.custom_tool_use'
  | 'agent.thread_context_compacted'
  // Streaming events (transient — broadcast over SSE only, never persisted)
  | 'agent.message_stream_start'
  | 'agent.message_chunk'
  | 'agent.message_stream_end'
  | 'agent.thinking_stream_start'
  | 'agent.thinking_chunk'
  // Session events (7)
  | 'session.status_idle'
  | 'session.status_running'
  | 'session.status_rescheduled'
  | 'session.status_terminated'
  | 'session.error'
  | 'session.deleted'
  | 'session.usage'
  // Span events (5)
  | 'span.model_request_start'
  | 'span.model_request_end'
  | 'span.outcome_evaluation_start'
  | 'span.outcome_evaluation_ongoing'
  | 'span.outcome_evaluation_end'
  // Terminal event (1)
  | 'turn_complete';

// ============================================================
// Content Blocks
// ============================================================

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ImageSource {
  type: 'base64' | 'url' | 'file';
  media_type?: string;
  data?: string;
  url?: string;
  file_id?: string;
}

export interface ImageBlock {
  type: 'image';
  source: ImageSource;
}

export interface DocumentSource {
  type: 'base64' | 'url' | 'file' | 'text';
  media_type?: string;
  data?: string;
  url?: string;
  file_id?: string;
}

export interface DocumentBlock {
  type: 'document';
  source: DocumentSource;
  title?: string;
  context?: string;
  citations?: { enabled: boolean };
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
  /**
   * Set on tool_use blocks emitted for calls awaiting human approval
   * (permission policy `always_ask`). The Console reads this flag to render
   * the approval card; without it a session stuck in `requires_action` has
   * no actionable UI.
   */
  requires_confirmation?: boolean;
  /** Identifies all approval-gated tool calls emitted in the same model step. */
  confirmation_group_id?: string;
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string | ContentBlock[];
  is_error?: boolean;
}

export type ContentBlock =
  | TextBlock
  | ImageBlock
  | DocumentBlock
  | ToolUseBlock
  | ToolResultBlock;

// ============================================================
// Event Base
// ============================================================

export interface EventBase {
  /** Event ID, prefixed with `sevt_` */
  id?: string;
  /** ISO 8601 timestamp when the event was processed by the agent */
  processed_at?: string;
  /** Causal predecessor event ID */
  parent_event_id?: string;
  /** Free-form metadata extension point */
  metadata?: Record<string, unknown>;
}

// ============================================================
// User Events (sent to session)
// ============================================================

export interface UserMessageEvent extends EventBase {
  type: 'user.message';
  content: ContentBlock[];
}

export interface UserInterruptEvent extends EventBase {
  type: 'user.interrupt';
}

export interface UserToolConfirmationEvent extends EventBase {
  type: 'user.tool_confirmation';
  tool_use_id: string;
  result: 'allow' | 'deny';
  deny_message?: string;
}

export interface UserCustomToolResultEvent extends EventBase {
  type: 'user.custom_tool_result';
  custom_tool_use_id: string;
  content: ContentBlock[];
  is_error?: boolean;
}

/**
 * The document an outcome is graded against.
 *
 * A union rather than two optional fields: a text rubric and a file reference are
 * different inputs, and accepting both would leave a caller unsure which one the
 * runtime used.
 */
export type OutcomeRubric =
  | { type: 'text'; content: string }
  | { type: 'file'; file_id: string };

/**
 * `user.define_outcome` — the client's success criteria for the session.
 *
 * The event carries no `content` blocks: its payload is a description, a rubric and an
 * iteration budget, which the event log persists through its metadata carrier and the
 * projection lifts back to these top-level fields. `max_iterations` is always present
 * once the event is admitted, because the ingress normalizer fills the default.
 */
export interface UserDefineOutcomeEvent extends EventBase {
  type: 'user.define_outcome';
  description: string;
  rubric: OutcomeRubric;
  max_iterations: number;
}

/**
 * A mid-turn steering instruction for an engine that owns a live input channel.
 *
 * Deliberately not a `user.message`: a message is queued on the session's
 * serialized execution chain and starts a turn, whereas a steer has to reach the
 * turn that is *already running*. Keeping the two apart is what lets the runtime
 * refuse a steer that arrives with nothing to steer instead of buffering it for
 * a later turn the caller never aimed it at.
 *
 * `input_id` is the idempotency key. Repeating it with the same `text` is a
 * duplicate the engine is not told twice; repeating it with different text is a
 * conflict and is refused rather than applied.
 */
export interface UserSteerEvent extends EventBase {
  type: 'user.steer';
  input_id: string;
  text: string;
  /** When present, the steer is refused unless it names the active turn. */
  expected_turn_id?: string;
}

export type UserEvent =
  | UserMessageEvent
  | UserInterruptEvent
  | UserToolConfirmationEvent
  | UserCustomToolResultEvent
  | UserDefineOutcomeEvent
  | UserSteerEvent;

// ============================================================
// Agent Events (emitted during execution)
// ============================================================

export interface AgentMessageEvent extends EventBase {
  type: 'agent.message';
  content: ContentBlock[];
  message_id?: string;
}

export interface AgentThinkingEvent extends EventBase {
  type: 'agent.thinking';
  text?: string;
  thinking_id?: string;
  providerOptions?: Record<string, unknown>;
}

export interface AgentToolUseEvent extends EventBase {
  type: 'agent.tool_use';
  /** Tool use ID for pairing with tool_result */
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AgentToolResultEvent extends EventBase {
  type: 'agent.tool_result';
  tool_use_id: string;
  content: string | ContentBlock[];
  is_error?: boolean;
}

export interface AgentMcpToolUseEvent extends EventBase {
  type: 'agent.mcp_tool_use';
  id: string;
  mcp_server_name: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AgentMcpToolResultEvent extends EventBase {
  type: 'agent.mcp_tool_result';
  mcp_tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export interface AgentCustomToolUseEvent extends EventBase {
  type: 'agent.custom_tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AgentThreadContextCompactedEvent extends EventBase {
  type: 'agent.thread_context_compacted';
}

export type AgentEvent =
  | AgentMessageEvent
  | AgentThinkingEvent
  | AgentToolUseEvent
  | AgentToolResultEvent
  | AgentMcpToolUseEvent
  | AgentMcpToolResultEvent
  | AgentCustomToolUseEvent
  | AgentThreadContextCompactedEvent;

// ============================================================
// Session Events (lifecycle status changes)
// ============================================================

export interface SessionStatusIdleEvent extends EventBase {
  type: 'session.status_idle';
  stop_reason?: {
    type: 'end_turn' | 'requires_action';
    event_ids?: string[];
    action_type?: 'tool_confirmation' | 'custom_tool_result';
  };
}

export interface SessionStatusRunningEvent extends EventBase {
  type: 'session.status_running';
}

export interface SessionStatusRescheduledEvent extends EventBase {
  type: 'session.status_rescheduled';
}

export interface SessionStatusTerminatedEvent extends EventBase {
  type: 'session.status_terminated';
  reason?: string;
}

/**
 * Retry disposition carried by `session.error`.
 *
 * Contract note: the published contract documents a typed `error` object
 * carrying `retry_status`, but the value set is not enumerated there. These
 * three strings are therefore a SandBase profile, not a verified upstream
 * enumeration. Only the field's type and presence are asserted; a client must
 * treat an unrecognized value as `unknown`.
 */
export type SessionErrorRetryStatus = 'retryable' | 'not_retryable' | 'unknown';

export interface SessionErrorEvent extends EventBase {
  type: 'session.error';
  error: {
    type: string;
    message: string;
    retry_status: SessionErrorRetryStatus;
  };
}

export interface SessionDeletedEvent extends EventBase {
  type: 'session.deleted';
}

/**
 * A money amount in the published wire form: an integer number of cents written
 * as a string, so the value never passes through a float.
 */
export interface MonetaryAmount {
  amount: string;
  currency: 'USD';
}

/**
 * A session's optional spending ceiling. The published contract defines exactly
 * one budget type; any other value is refused rather than ignored.
 */
export interface SessionBudget {
  type: 'limit';
  max_list_cost: MonetaryAmount;
}

/**
 * Usage snapshot for a session, emitted immediately before every
 * `session.status_idle`.
 *
 * `list_cost` is present only when a cost profile priced every model the
 * session used. It is omitted — never reported as a zero or a partial total —
 * when some model has no list price, because a lower bound presented as the
 * total would understate spend to a caller who is choosing a new cap.
 *
 * `budget` echoes the session's budget, or `null` when it has none: this
 * runtime holds that value, so "no budget" is a fact it can state rather than
 * one it must leave out. `server_tool_use` reports the built-in web-tool
 * counters, and both are genuinely zero because no built-in web tool runs.
 */
export interface SessionUsageEvent extends EventBase {
  type: 'session.usage';
  usage: {
    input_tokens: number;
    output_tokens: number;
    /** Wall-clock seconds the harness loop was executing this session. */
    active_seconds: number;
    /** Accumulated list cost in whole cents; omitted when incomplete. */
    list_cost?: number;
    /** The session's budget echo, or `null` when it has none. */
    budget?: SessionBudget | null;
    server_tool_use?: {
      web_search_requests: number;
      web_fetch_requests: number;
    };
  };
}

export type SessionLifecycleEvent =
  | SessionStatusIdleEvent
  | SessionStatusRunningEvent
  | SessionStatusRescheduledEvent
  | SessionStatusTerminatedEvent
  | SessionErrorEvent
  | SessionDeletedEvent
  | SessionUsageEvent;

// ============================================================
// Span Events (observability)
// ============================================================

export interface SpanModelRequestStartEvent extends EventBase {
  type: 'span.model_request_start';
  model?: string;
}

export interface SpanModelRequestEndEvent extends EventBase {
  type: 'span.model_request_end';
  model_request_start_id?: string;
  is_error?: boolean;
  model_usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

/**
 * Verdict of one outcome evaluation, as published on
 * `span.outcome_evaluation_end`.
 *
 * `satisfied` and `failed` end the outcome; `needs_revision` asks for another
 * iteration. `max_iterations_reached`, `interrupted` and `budget_reached` are
 * properties of the iteration budget, the session's lifecycle and its spending
 * ceiling rather than of the deliverable, so they are decided by the loop and not
 * by the grader.
 */
export type OutcomeEvaluationResult =
  | 'satisfied'
  | 'needs_revision'
  | 'failed'
  | 'max_iterations_reached'
  | 'interrupted'
  | 'budget_reached';

/** Where the session log holds a `user.define_outcome` payload. */
export interface SpanOutcomeEvaluationMetadata extends Record<string, unknown> {
  outcome_id: string;
  /** `0` is the evaluation of the declared outcome before any revision. */
  iteration: number;
  /** Present on the end span only. */
  result?: OutcomeEvaluationResult;
  explanation?: string;
  /** The start span this end span closes; `''` when no evaluation began. */
  outcome_evaluation_start_id?: string;
}

export interface SpanOutcomeEvaluationStartEvent extends EventBase {
  type: 'span.outcome_evaluation_start';
  metadata?: SpanOutcomeEvaluationMetadata;
}

export interface SpanOutcomeEvaluationOngoingEvent extends EventBase {
  type: 'span.outcome_evaluation_ongoing';
  metadata?: SpanOutcomeEvaluationMetadata;
}

export interface SpanOutcomeEvaluationEndEvent extends EventBase {
  type: 'span.outcome_evaluation_end';
  metadata?: SpanOutcomeEvaluationMetadata;
}

export type SpanEvent =
  | SpanModelRequestStartEvent
  | SpanModelRequestEndEvent
  | SpanOutcomeEvaluationStartEvent
  | SpanOutcomeEvaluationOngoingEvent
  | SpanOutcomeEvaluationEndEvent;

// ============================================================
// Terminal Event
// ============================================================

export interface TurnCompleteEvent extends EventBase {
  type: 'turn_complete';
}

// ============================================================
// Union of all CMA events
// ============================================================

export type CMAEvent =
  | UserEvent
  | AgentEvent
  | SessionLifecycleEvent
  | SpanEvent
  | TurnCompleteEvent;
