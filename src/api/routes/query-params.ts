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
