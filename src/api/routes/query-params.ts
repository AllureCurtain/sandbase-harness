/**
 * Query-parameter admission.
 *
 * A route that ignores a parameter it does not implement answers a question the
 * caller did not ask: `?deployment_id=nope` and a misspelled filter both return
 * `200` with an empty or unfiltered page, and nothing in that response invites
 * the caller to look again. This is the failure mode the agent update path
 * already refuses for fields — `Unknown agent update field "x"` — applied to the
 * query string, where it had no equivalent.
 *
 * The allow-list is passed by the handler that reads the parameters rather than
 * kept in a table here. A central table mapping every route to its parameters
 * would be a second description of the same thing, and the kind that drifts:
 * a parameter added to a handler would be refused by a list maintained
 * elsewhere, so the handler that knows what it reads is the only thing that can
 * keep the list true.
 *
 * The check runs before resource lookup, so a malformed request is reported as
 * malformed rather than as a missing resource. Validation of the request
 * precedes reading state, the same order admission middleware runs in.
 */

import {
  cursorPageOf,
  cursorQueryMismatch,
  decodeCursor,
  encodeCursor,
  type ApiCursorPage,
} from '../standard.js';

/**
 * Published examples put this on the URL rather than in a header
 * (`?beta=true`, and `?beta=true&deployment_id=...`, 36 occurrences in the
 * published documentation), so refusing it would make this runtime unreachable
 * from a client built against that documentation.
 *
 * Accepted and **ignored**: its compatibility semantics are not modelled, and a
 * caller must not read the acceptance as honouring it. It is deliberately not
 * listed in the refusal message's "accepts" list, because that list names the
 * parameters a route implements and this is not one of them.
 */
export const COMPATIBILITY_QUERY_PARAMS: readonly string[] = ['beta'];

/** Query parameters present on the request that the caller may not use here. */
export function unexpectedQueryParams(
  request: { query(): Record<string, string> },
  allowed: readonly string[],
): string[] {
  const permitted = new Set<string>([...allowed, ...COMPATIBILITY_QUERY_PARAMS]);
  return Object.keys(request.query()).filter((name) => !permitted.has(name));
}

/**
 * The published parameter that admits archived records into a collection page.
 *
 * It is defined once because two collections take it — vaults and memory stores —
 * and a validation rule this specific kept in two places is two places for the
 * accepted values to drift, with the second copy the one that gets forgotten.
 * The published wording is the same for both: "默认排除已归档的记录（传递
 * `include_archived=true` 可将其包含在内）" (`将工作委派给智能体/使用保管库进行身份验证.md:1119`)
 * and "默认排除已归档的存储；传递 `include_archived: true` 可将其包含在内"
 * (`管理智能体上下文/记忆存储.md:1206`).
 */
export const INCLUDE_ARCHIVED_PARAM = 'include_archived';

/**
 * Read the published `include_archived` listing parameter.
 *
 * Only the two documented spellings are accepted. Anything else — `1`, `yes`, an
 * empty string — is a `400` rather than a fall-back to the default, because a
 * caller who wrote something meant it and must not have it silently
 * reinterpreted. That is the same rule the agent update path applies to a
 * malformed concurrency precondition, and the reason is the same: a request that
 * looks filtered must not be answered as if it were not.
 *
 * `include_archived=false` is accepted and means the default. The parameter is
 * boolean, so the explicit negative is the same request as omitting it, and
 * refusing it would make a caller-generated `false` fail while `true` succeeds.
 *
 * A repeated parameter is refused instead of taking the first or last value: the
 * caller sent two contradictory requests and there is no reading of them that is
 * not a guess. This needs `queries()` rather than `query()` — measured, because
 * the two look interchangeable and are not: `query()` returns the **first** value
 * for a repeated parameter, so a first-wins read of
 * `?include_archived=true&include_archived=false` answers `200` and silently
 * picks one of the two values the caller sent.
 */
export function parseIncludeArchived(
  c: { req: { queries(name: string): string[] | undefined }; json(body: unknown, status: 400): Response },
): { ok: true; value: boolean } | { ok: false; response: Response } {
  const all = c.req.queries(INCLUDE_ARCHIVED_PARAM) ?? [];
  if (all.length === 0) return { ok: true, value: false };

  if (all.length > 1) {
    return {
      ok: false,
      response: c.json({
        error: {
          type: 'invalid_request_error',
          message: `${INCLUDE_ARCHIVED_PARAM} was sent ${all.length} times `
            + `(${all.map((value) => `"${value}"`).join(', ')}). Send it once, as `
            + `${INCLUDE_ARCHIVED_PARAM}=true or ${INCLUDE_ARCHIVED_PARAM}=false.`,
        },
      }, 400),
    };
  }

  const raw = all[0];
  if (raw === 'true') return { ok: true, value: true };
  if (raw === 'false') return { ok: true, value: false };

  return {
    ok: false,
    response: c.json({
      error: {
        type: 'invalid_request_error',
        message: `Invalid ${INCLUDE_ARCHIVED_PARAM} value "${raw}". `
          + `This route accepts ${INCLUDE_ARCHIVED_PARAM}=true or ${INCLUDE_ARCHIVED_PARAM}=false.`,
      },
    }, 400),
  };
}

/**
 * Reject the request when it carries a query parameter this route does not
 * implement, naming the parameter and the ones that are implemented.
 *
 * Returns a `Response` to return, or `null` when the request is acceptable, so a
 * handler reads as `const rejected = ...; if (rejected) return rejected;`.
 */
export function rejectUnexpectedQueryParams(
  c: any,
  allowed: readonly string[],
): Response | null {
  const unexpected = unexpectedQueryParams(c.req, allowed);
  if (unexpected.length === 0) return null;

  const named = unexpected.map((name) => `"${name}"`).join(', ');
  const accepts = allowed.length > 0
    ? ` This route accepts: ${allowed.join(', ')}.`
    : ' This route accepts no query parameters.';
  return c.json({
    error: {
      type: 'invalid_request_error',
      message: `Unknown query parameter${unexpected.length > 1 ? 's' : ''} ${named}.${accepts}`,
    },
  }, 400);
}

/**
 * The two published pagination parameters.
 *
 * The published wording is "使用 `limit`（默认 20，最大 100）和 `page` 游标进行分页"
 * (`管理智能体上下文/Dreams.md:575`), and the collection listings it governs are
 * described as paginated under the same rule ("分页返回，最新的在前",
 * `将工作委派给智能体/使用保管库进行身份验证.md:1119`).
 */
export const LIMIT_PARAM = 'limit';
export const PAGE_PARAM = 'page';
/** The published default page size. */
export const COLLECTION_DEFAULT_LIMIT = 20;
/** The published maximum page size. */
export const COLLECTION_MAX_LIMIT = 100;

/**
 * The admission list for the two collection listings, built from the parameter names
 * the readings above use so it cannot disagree with them.
 *
 * This is not the central route-to-parameter table this module's header argues
 * against. That table would describe routes whose parameters differ, and would be a
 * second description of each of them. This describes **one** set of parameters read by
 * **one** pair of handlers through the same two helpers — vaults and memory stores take
 * the same three, which is why the readings themselves were extracted here. Deriving
 * the list from the exported names rather than repeating the strings is what keeps
 * admission and validation from drifting: a fourth parameter read by both would have to
 * be added here to be accepted, and the test asserts the two collections advertise the
 * identical list.
 */
export const COLLECTION_LISTING_QUERY_PARAMS: readonly string[] = [
  INCLUDE_ARCHIVED_PARAM,
  LIMIT_PARAM,
  PAGE_PARAM,
];

/**
 * A validated window over one collection.
 *
 * `slice` takes the whole ordered collection and returns the requested page with
 * its continuation cursors, so the cursor and the slice are produced by the same
 * state and cannot describe different requests.
 */
export interface CollectionWindow {
  limit: number;
  page: number;
  slice<T>(items: T[]): ApiCursorPage<T>;
}

interface WindowContext {
  req: {
    queries(name: string): string[] | undefined;
    query(name: string): string | undefined;
  };
  json(body: unknown, status: 400): Response;
}

/**
 * Read the published `limit`/`page` window for a collection listing.
 *
 * `order` and `filter` are stored **inside** the cursor, as the session listing
 * does, because a page number is only meaningful against the ordering and filter
 * that produced it: replaying a cursor under a different `include_archived` would
 * otherwise answer a page that never existed for that query, and a page number on
 * its own cannot notice. `order` is a per-collection token rather than the raw SQL
 * clause so that a cursor issued by one collection is refused by another.
 *
 * Both parameters refuse a value they do not implement instead of falling back to
 * the default. A caller who asked for `limit=500` and received 100 rows, or who
 * asked for `limit=abc` and received 20, has been answered as though they asked
 * for something else — the failure this module exists to name. Out of range is
 * therefore a `400` naming the range rather than a silent clamp: if a clamp is
 * wanted later it should be one deliberate decision, not the shape of a default.
 *
 * A repeated parameter is refused for the same reason `include_archived` is: two
 * values are two requests and there is no reading of them that is not a guess.
 */
export function parseCollectionWindow(
  c: WindowContext,
  options: { order: string; filter?: Record<string, string> },
): { ok: true; value: CollectionWindow } | { ok: false; response: Response } {
  const limitResult = parseCollectionLimit(c);
  if (!limitResult.ok) return limitResult;

  const rawPages = c.req.queries(PAGE_PARAM) ?? [];
  if (rawPages.length > 1) {
    return {
      ok: false,
      response: c.json({
        error: {
          type: 'invalid_request_error',
          message: `${PAGE_PARAM} was sent ${rawPages.length} times `
            + `(${rawPages.map((value) => `"${value}"`).join(', ')}). Send it once, as the cursor `
            + `returned by this endpoint as ${PAGE_PARAM}.`,
        },
      }, 400),
    };
  }

  const rawPage = rawPages[0];
  const state = { order: options.order, filter: options.filter ?? {} };
  let page = 1;
  if (rawPage !== undefined) {
    const decoded = decodeCursor(rawPage);
    if (!decoded.ok) return { ok: false, response: invalidPage(c) };
    const mismatch = cursorQueryMismatch(decoded.state, state);
    if (mismatch) {
      return { ok: false, response: c.json({ error: { type: 'invalid_request_error', message: mismatch } }, 400) };
    }
    const decodedPage = readPageNumber(decoded.state);
    if (decodedPage === undefined) return { ok: false, response: invalidPage(c) };
    page = decodedPage;
  }

  const limit = limitResult.value;
  return {
    ok: true,
    value: {
      limit,
      page,
      slice<T>(items: T[]): ApiCursorPage<T> {
        const start = (page - 1) * limit;
        return cursorPageOf(items.slice(start, start + limit), {
          prev: page > 1 ? encodeCursor({ ...state, page: page - 1 }) : null,
          next: start + limit < items.length ? encodeCursor({ ...state, page: page + 1 }) : null,
        });
      },
    },
  };
}

function parseCollectionLimit(
  c: WindowContext,
): { ok: true; value: number } | { ok: false; response: Response } {
  const accepted = `an integer from 1 to ${COLLECTION_MAX_LIMIT}`;
  const all = c.req.queries(LIMIT_PARAM) ?? [];
  if (all.length === 0) return { ok: true, value: COLLECTION_DEFAULT_LIMIT };

  if (all.length > 1) {
    return {
      ok: false,
      response: c.json({
        error: {
          type: 'invalid_request_error',
          message: `${LIMIT_PARAM} was sent ${all.length} times `
            + `(${all.map((value) => `"${value}"`).join(', ')}). Send it once, as ${accepted}.`,
        },
      }, 400),
    };
  }

  const raw = all[0]!;
  // `Number('')` is `0` and `Number(' 5 ')` is `5`, so the digits are checked
  // before the conversion rather than after it.
  if (!/^\d+$/.test(raw)) return { ok: false, response: invalidLimit(c, raw, accepted) };
  const value = Number(raw);
  if (value < 1 || value > COLLECTION_MAX_LIMIT) {
    return { ok: false, response: invalidLimit(c, raw, accepted) };
  }
  return { ok: true, value };
}

function invalidLimit(c: WindowContext, raw: string, accepted: string): Response {
  return c.json({
    error: {
      type: 'invalid_request_error',
      message: `Invalid ${LIMIT_PARAM} value "${raw}". ${LIMIT_PARAM} must be ${accepted}.`,
    },
  }, 400);
}

function invalidPage(c: WindowContext): Response {
  return c.json({
    error: {
      type: 'invalid_request_error',
      message: `${PAGE_PARAM} must be a cursor returned by this endpoint`,
    },
  }, 400);
}

/** A cursor's page number, or `undefined` when it does not carry a usable one. */
function readPageNumber(state: Record<string, unknown> | undefined): number | undefined {
  const value = state?.page;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return undefined;
  return value;
}
