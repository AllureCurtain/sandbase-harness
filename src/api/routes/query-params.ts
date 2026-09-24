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
