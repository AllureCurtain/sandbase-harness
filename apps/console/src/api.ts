import type { Page } from './types';

const API_KEY_STORAGE_KEY = 'managed-agents.api-key';

export function getStoredApiKey(): string {
  return browserStorage()?.getItem(API_KEY_STORAGE_KEY) ?? '';
}

export function setStoredApiKey(key: string): void {
  if (key.trim()) {
    browserStorage()?.setItem(API_KEY_STORAGE_KEY, key.trim());
  }
}

export function clearStoredApiKey(): void {
  browserStorage()?.removeItem(API_KEY_STORAGE_KEY);
}

export async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: authHeaders() });
  if (!res.ok) throw new Error(`${path} returned ${res.status}`);
  return res.json() as Promise<T>;
}

export async function getText(path: string): Promise<string> {
  const res = await fetch(path, { headers: authHeaders() });
  if (!res.ok) throw new Error(`${path} returned ${res.status}`);
  return res.text();
}

export async function getPage<T>(path: string): Promise<Page<T>> {
  return getJson<Page<T>>(path);
}

export async function postJson<T>(path: string, body: unknown): Promise<T> {
  return requestJson<T>(path, 'POST', body);
}

export async function postForm<T>(path: string, body: FormData): Promise<T> {
  const res = await fetch(path, { method: 'POST', headers: authHeaders(), body });
  if (!res.ok) {
    const detail = await res.json().catch(() => null) as ErrorResponse | null;
    throw new Error(errorMessage(path, res.status, detail));
  }
  return res.json() as Promise<T>;
}

export async function putJson<T>(path: string, body: unknown): Promise<T> {
  return requestJson<T>(path, 'PUT', body);
}

export async function deleteJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { method: 'DELETE', headers: authHeaders() });
  if (!res.ok) {
    const detail = await res.json().catch(() => null) as ErrorResponse | null;
    throw new Error(errorMessage(path, res.status, detail));
  }
  return res.json() as Promise<T>;
}

export type ServerSentEvent<T = unknown> = {
  event: string;
  data: T;
  id?: string;
};

/** Read a resumable SSE response and dispatch complete events as they arrive. */
export async function readEventStream(
  path: string,
  onEvent: (event: ServerSentEvent) => void,
  options: { signal?: AbortSignal; lastEventId?: string } = {},
): Promise<void> {
  const headers: HeadersInit = {
    ...authHeaders(),
    Accept: 'text/event-stream',
    ...(options.lastEventId ? { 'Last-Event-ID': options.lastEventId } : {}),
  };
  const response = await fetch(path, { headers, signal: options.signal });
  await readEventStreamResponse(path, response, onEvent);
}

/** Post a message and consume its resumable SSE response. */
export async function postEventStream(
  path: string,
  body: unknown,
  onEvent: (event: ServerSentEvent) => void,
  options: { signal?: AbortSignal; lastEventId?: string } = {},
): Promise<void> {
  const headers: HeadersInit = {
    ...authHeaders(),
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    ...(options.lastEventId ? { 'Last-Event-ID': options.lastEventId } : {}),
  };
  const response = await fetch(path, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: options.signal,
  });
  await readEventStreamResponse(path, response, onEvent);
}

async function readEventStreamResponse(
  path: string,
  response: Response,
  onEvent: (event: ServerSentEvent) => void,
): Promise<void> {
  if (!response.ok) {
    const detail = await response.json().catch(() => null) as ErrorResponse | null;
    throw new Error(errorMessage(path, response.status, detail));
  }
  if (!response.body) throw new Error('The event stream did not return a readable body');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let eventName = 'message';
  let eventId: string | undefined;
  let dataLines: string[] = [];

  const dispatch = () => {
    if (dataLines.length === 0) return;
    const raw = dataLines.join('\n');
    let data: unknown = raw;
    try {
      data = JSON.parse(raw);
    } catch {
      // Heartbeats and future plain-text events are still delivered as strings.
    }
    onEvent({ event: eventName, data, ...(eventId ? { id: eventId } : {}) });
    eventName = 'message';
    eventId = undefined;
    dataLines = [];
  };

  try {
    while (true) {
      const result = await reader.read();
      buffer += decoder.decode(result.value ?? new Uint8Array(), { stream: !result.done });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line === '') {
          dispatch();
          continue;
        }
        if (line.startsWith(':')) continue;
        const separator = line.indexOf(':');
        const field = separator >= 0 ? line.slice(0, separator) : line;
        const value = separator >= 0 ? line.slice(separator + 1).replace(/^ /, '') : '';
        if (field === 'event') eventName = value;
        else if (field === 'id') eventId = value;
        else if (field === 'data') dataLines.push(value);
      }
      if (result.done) {
        buffer += decoder.decode();
        if (buffer) dataLines.push(buffer);
        dispatch();
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function requestJson<T>(path: string, method: 'POST' | 'PUT', body: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null) as ErrorResponse | null;
    throw new Error(errorMessage(path, res.status, detail));
  }
  return res.json() as Promise<T>;
}

type ErrorResponse = {
  error?: { message?: string };
  errors?: Array<{ path?: string; message?: string }>;
};

function errorMessage(path: string, status: number, detail: ErrorResponse | null): string {
  if (detail?.errors?.length) {
    return detail.errors
      .map((item) => `${item.path || 'config'}: ${item.message || 'Invalid value'}`)
      .join('\n');
  }
  return detail?.error?.message ?? `${path} returned ${status}`;
}

function authHeaders(): HeadersInit {
  const key = getStoredApiKey();
  return key ? { Authorization: `Bearer ${key}` } : {};
}

function browserStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage;
}
