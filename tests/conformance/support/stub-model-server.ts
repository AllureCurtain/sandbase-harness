/**
 * A model provider the conformance suite starts itself, for the tests that need
 * a turn to actually run.
 *
 * `tests/conformance` is otherwise a shape-layer suite: it asserts what the API
 * answers without a model, which is why its shared driver deliberately
 * configures none. The official-SDK quickstart cannot be checked that way — a
 * quickstart that never reaches `agent.message` proves the endpoints exist, not
 * that an official client can drive a turn — so this file supplies the smallest
 * provider that can produce one: an OpenAI-compatible `/v1/chat/completions`
 * endpoint that answers with a tool call, then with text, then stops.
 *
 * It is registered by the *test* and only by the test: a workspace config names
 * this server's URL as its provider base URL, and nothing under `src/` knows it
 * exists. That is the whole of its relationship to the runtime (D28) — a stub
 * model is a test fixture, never a provider a user can select, so it is not in
 * Settings, not in the CLI, and not in the docs. If a user could choose it, the
 * no-key experience it offers would be a capability this project does not have.
 *
 * The reply is deliberately the shape a real OpenAI-compatible provider sends,
 * including split `tool_calls` argument fragments and a trailing usage chunk,
 * because those are the parts of the wire format the runtime has to assemble
 * correctly for the turn to reach a terminal state.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** The text the second (post-tool) turn answers with, so a test can assert it. */
export const STUB_REPLY_TEXT = 'Hello from the SandBase Harness conformance model.';

/** Tools the stub will call, in preference order, when the runtime offers them. */
const TOOL_PREFERENCE = ['glob', 'read', 'bash'] as const;

/** Arguments per preferred tool, so the call is valid for the tool it names. */
const TOOL_ARGUMENTS: Record<string, unknown> = {
  glob: { pattern: '*' },
  read: { path: 'README.md' },
  bash: { command: 'echo conformance' },
};

interface ChatMessage {
  role?: string;
  content?: unknown;
}

interface ChatTool {
  type?: string;
  function?: { name?: string };
}

export interface StubModelRequest {
  model?: string;
  stream?: boolean;
  messages?: ChatMessage[];
  tools?: ChatTool[];
  /** Anthropic `/v1/messages` bodies carry a `system` block array instead. */
  system?: unknown;
}

export interface StubModelServer {
  /** Base URL to put in a workspace's provider config, e.g. `http://127.0.0.1:1234/v1`. */
  baseUrl: string;
  /** Every request the runtime sent, in order, with its tool list and messages. */
  requests: StubModelRequest[];
  /** The tool the stub called in its first reply, once one has been issued. */
  calledTool?: string;
  close(): Promise<void>;
}

/** A tool call the stub should issue, instead of picking from what is offered. */
export interface StubToolCall {
  name: string;
  arguments?: unknown;
}

export interface StubModelServerOptions {
  /**
   * The calls the first tool-calling reply issues, in order.
   *
   * Without this the stub picks one tool from the ones the runtime offers
   * (`TOOL_PREFERENCE`), which is what the conformance quickstart needs. A test
   * that has to park a *particular* call — a custom tool, a gated tool the
   * default preference would not reach — names it here instead, and naming more
   * than one issues them in the same reply, which is how one model step parks
   * two calls at once (`confirmation_group_id`).
   */
  toolCalls?: StubToolCall[];
  /**
   * Ordinals of requests to refuse instead of answering, 1-based.
   *
   * A turn that fails is as much a wire shape as one that succeeds, and it has to
   * be scripted per request: a test that needs the failure on the *resumed*
   * request (after a tool ran) or on the first turn only cannot get it from a
   * server that always fails. A refusal the runtime retries consumes one ordinal
   * per attempt, so a list writes the whole retry: `[2, 3, 4]` fails the three
   * attempts of the resumed request and nothing else.
   */
  failRequests?: number[];
  /**
   * Status for the requests in `failRequests` (default `500`).
   *
   * `500` is an internal error the runtime treats as terminal for the session;
   * `401` is a credential failure it does not retry and the session can continue
   * from, which is the pair a client's two failure paths need.
   */
  failStatus?: number;
  holdRequests?: number[];
  /**
   * Reply text for specific requests, by 1-based ordinal — the same numbering
   * `failRequests` uses.
   *
   * The outcome grader is a second model caller behind the same provider, and a
   * test that needs a particular verdict has to make the grader's request answer
   * with it: the stub's default text parses as `needs_revision`, so an outcome
   * that should close `satisfied` scripts its grading call here. Requests not
   * named keep the default behavior — tool call first, `STUB_REPLY_TEXT` after.
   */
  replyTexts?: Record<number, string>;
}

export async function startStubModelServer(options: StubModelServerOptions = {}): Promise<StubModelServer> {
  const requests: StubModelRequest[] = [];
  let calledTool: string | undefined;

  const server = createServer((req, res) => {
    const isOpenAi = req.method === 'POST' && Boolean(req.url?.endsWith('/chat/completions'));
    const isAnthropic = req.method === 'POST' && Boolean(req.url?.endsWith('/messages'));
    if (!isOpenAi && !isAnthropic) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `no stub route for ${req.method} ${req.url}` } }));
      return;
    }
    void readJson(req).then((body) => {
      const request = body as StubModelRequest;
      requests.push(request);
      if (options.holdRequests?.includes(requests.length)) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.flushHeaders();
        return;
      }
      if (options.failRequests?.includes(requests.length)) {
        const status = options.failStatus ?? 500;
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `scripted ${status}`, type: 'invalid_request_error' } }));
        return;
      }
      // The Anthropic Messages route answers the fixed reply only — its job is
      // recording what the provider was asked for (cache breakpoints, effort
      // fields), not scripting a turn.
      if (isAnthropic) {
        respondAnthropic(res, options.replyTexts?.[requests.length] ?? STUB_REPLY_TEXT, request.model);
        return;
      }
      const scripted = options.replyTexts?.[requests.length];
      if (scripted !== undefined) {
        respond(req, res, request, { text: scripted });
        return;
      }
      if (wantToolCall(request)) {
        const scripted = options.toolCalls;
        if (scripted?.length) {
          calledTool = scripted[0].name;
          respond(req, res, request, { tools: scripted });
          return;
        }
        if (calledTool === undefined) {
          const tool = pickTool(request.tools);
          // Only the first reply calls a tool: the runtime then sends the result
          // back, and the second reply has to end the turn or the session never
          // reaches idle and the quickstart would hang instead of failing.
          if (tool) {
            calledTool = tool;
            respond(req, res, request, { tools: [{ name: tool, arguments: TOOL_ARGUMENTS[tool] ?? {} }] });
            return;
          }
        }
      }
      respond(req, res, request, { text: STUB_REPLY_TEXT });
    }).catch((error: unknown) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: String(error) } }));
    });
  });

  await listen(server);
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    get calledTool() {
      return calledTool;
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** True while no tool result has come back yet: the tool-calling turn. */
function wantToolCall(request: StubModelRequest): boolean {
  return !(request.messages ?? []).some((message) => {
    if (message.role === 'tool') return true;
    return Array.isArray(message.content)
      && message.content.some((part) => {
        const type = (part as { type?: string } | null)?.type;
        return type === 'tool-result' || type === 'tool_result';
      });
  });
}

function pickTool(tools: ChatTool[] | undefined): string | undefined {
  const offered = new Set((tools ?? []).map((tool) => tool.function?.name).filter(Boolean));
  return TOOL_PREFERENCE.find((name) => offered.has(name));
}

function respond(
  req: IncomingMessage,
  res: ServerResponse,
  request: StubModelRequest,
  reply: { text?: string; tools?: StubToolCall[] },
): void {
  const model = request.model ?? 'stub-model';
  const id = `chatcmpl-stub-${Math.random().toString(36).slice(2, 10)}`;
  const created = Math.floor(Date.now() / 1000);
  const promptTokens = 12;
  const completionTokens = 7;
  const toolCalls = reply.tools?.map((tool, index) => ({
    id: `call_stub_${index + 1}`,
    type: 'function' as const,
    function: { name: tool.name, arguments: JSON.stringify(tool.arguments ?? {}) },
  }));

  if (!request.stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id,
      object: 'chat.completion',
      created,
      model,
      choices: [{
        index: 0,
        message: toolCalls?.length
          ? { role: 'assistant', content: null, tool_calls: toolCalls }
          : { role: 'assistant', content: reply.text ?? '' },
        finish_reason: toolCalls?.length ? 'tool_calls' : 'stop',
      }],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    }));
    return;
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const chunk = (delta: unknown, finishReason: string | null = null) => {
    res.write(`data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`);
  };

  chunk({ role: 'assistant', content: '' });
  if (toolCalls?.length) {
    // Split each argument object across fragments: a provider is allowed to, and
    // the runtime has to reassemble it before the tool call is executable.
    toolCalls.forEach((call, index) => {
      chunk({
        tool_calls: [{
          index,
          id: call.id,
          type: 'function',
          function: { name: call.function.name, arguments: '' },
        }],
      });
      const args = call.function.arguments;
      const cut = Math.max(1, Math.floor(args.length / 2));
      chunk({ tool_calls: [{ index, function: { arguments: args.slice(0, cut) } }] });
      chunk({ tool_calls: [{ index, function: { arguments: args.slice(cut) } }] });
    });
    chunk({}, 'tool_calls');
  } else {
    const text = reply.text ?? '';
    const cut = Math.max(1, Math.floor(text.length / 2));
    chunk({ content: text.slice(0, cut) });
    chunk({ content: text.slice(cut) });
    chunk({}, 'stop');
  }
  // The trailing usage chunk carries no choices, which is how an OpenAI-style
  // stream reports usage for the whole completion.
  res.write(`data: ${JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  })}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

/**
 * Minimal Anthropic Messages API stream: `message_start`, one text block,
 * `message_delta` with the terminal stop reason, `message_stop`. Enough for
 * `@ai-sdk/anthropic` to assemble a finished step; no tool calls.
 */
function respondAnthropic(res: ServerResponse, text: string, model?: string): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const frame = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  frame('message_start', {
    type: 'message_start',
    message: {
      id: `msg_stub_${Math.random().toString(36).slice(2, 10)}`,
      type: 'message',
      role: 'assistant',
      content: [],
      model: model ?? 'stub-model',
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 12, output_tokens: 1 },
    },
  });
  frame('content_block_start', {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  });
  frame('content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text },
  });
  frame('content_block_stop', { type: 'content_block_stop', index: 0 });
  frame('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: 7 },
  });
  frame('message_stop', { type: 'message_stop' });
  res.end();
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw.length > 0 ? JSON.parse(raw) : {};
}

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
}
