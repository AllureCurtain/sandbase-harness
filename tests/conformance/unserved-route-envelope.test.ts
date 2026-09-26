/**
 * A path this runtime does not serve answers in the documented JSON envelope.
 *
 * The second suite under `tests/conformance/`, and provider-free like the first.
 *
 * `src/api/server.ts:212-220` installs a `notFound` fallback with a stated
 * reason: Hono's default fallback is `text/plain` "404 Not Found", which "makes a
 * client's error decoder fail while parsing rather than branch on `error.type` —
 * the caller sees a transport-shaped failure for what is really a 404". The same
 * comment records a second decision that is only observable in a response: the
 * message deliberately does **not** echo the requested path, "there is no reason
 * to reflect caller input".
 *
 * The existing coverage asserts `res.status === 404` for a list of retired
 * endpoints (`tests/integration/api.test.ts:1572-1574`) and nothing about the
 * body, so the envelope, the `error.type`, the JSON content type and the
 * non-reflection were all implemented and unasserted.
 *
 * Not covered here: the fallback's behaviour for non-GET verbs, and whether a
 * client decoder is satisfied by the envelope in practice, which is what the
 * official SDK slice will settle.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { disposeConformanceContexts, makeConformanceApp, type ConformanceContext } from './support/app.js';

type TestContext = ConformanceContext;
const contexts: TestContext[] = [];

function app() {
  const ctx = makeConformanceApp('ma-conformance-404-');
  contexts.push(ctx);
  return ctx.app;
}

async function bodyOf(res: Response) {
  return (await res.json()) as { error?: { type?: string; message?: string } };
}

describe('unserved route envelope', () => {
  afterEach(() => {
    disposeConformanceContexts(contexts);
  });

  it('answers an unserved /v1 path in the JSON error envelope, not Hono text', async () => {
    const res = await app().request('/v1/definitely_not_a_route');

    expect(res.status).toBe(404);
    // The content type is the half that fails a client's decoder: a `text/plain`
    // body makes the failure look like a transport fault instead of a 404.
    expect(res.headers.get('content-type') ?? '').toContain('application/json');
    const body = await bodyOf(res);
    expect(body.error?.type).toBe('not_found');
    expect(body.error?.message).toBe('No route matches this request');
  });

  it('answers an unserved path outside /v1 the same way', async () => {
    // The fallback is installed on the app, not on the `/v1/*` mount, so the
    // consistency claim covers the whole surface rather than the API prefix.
    const res = await app().request('/definitely_not_a_route');

    expect(res.status).toBe(404);
    expect(res.headers.get('content-type') ?? '').toContain('application/json');
    expect((await bodyOf(res)).error?.type).toBe('not_found');
  });

  it('does not reflect the requested path back in the body', async () => {
    // A recorded decision, not an accident: the status and `error.type` carry the
    // meaning, so caller input has no reason to appear in the response.
    //
    // This reads the raw body rather than parsing it, and that is deliberate: the
    // claim is about what the body contains, so it must not be able to pass or
    // fail because of the content type. Parsing here made the case fail for a
    // different reason than the one it names the moment the envelope was broken.
    const marker = 'reflect_me_if_you_dare';
    const res = await app().request(`/v1/${marker}`);

    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain(marker);
  });
});
