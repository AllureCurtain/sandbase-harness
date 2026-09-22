# CMA Contract — pagination

Contract area: collection envelopes and cursors.
Status: `partial` — `/v1/x` extension collections keep the local envelope, see §4.
Source: Claude Managed Agents public documentation plus `src/api/standard.ts`.

---

## 1. Official definition

- Canonical collections return `{data, next_page, prev_page}`.
- `next_page` and `prev_page` are opaque cursors. The server generates them; the
  caller must not construct, parse, or reason about their contents.
- A cursor encodes the sort request that produced it. It must not be reused
  across a different `order` or an incompatible filter.
- The published contract does not define `first_id` / `last_id` / `has_more` as
  canonical pagination fields.

## 2. Current SandBase shape

`src/api/standard.ts` defines two envelopes and one decision point:

| Envelope | Shape | Used by |
| --- | --- | --- |
| `ApiCursorPage<T>` | `{data, prev_page, next_page}` | canonical `/v1` collections |
| `ApiPage<T>` | `{data, has_more, first_id, last_id}` | `/v1/x` extension collections |

- `encodeCursor` base64url-encodes the sort state that produced the page.
- `decodeCursor` rejects anything that is not a well-formed object, so a forged
  or truncated cursor fails rather than being interpreted loosely.
- `collectionPager(shape, ...)` is the single place the surface chooses its
  envelope, so handlers serving both prefixes cannot emit both spellings at once.
- A collection's envelope therefore follows the mount, not the handler: the
  operations router is mounted at `/v1` and `/v1/x` with different shapes, and a
  handler that emitted its own envelope could not do that.
- Converted to the canonical envelope so far: every operations collection
  (`/v1/webhooks`, `/v1/scheduled-deployments`, `/v1/outcomes`, their nested
  `deliveries` / `runs` and the session outcome listing); the resource collections
  that return their whole set (`/v1/credential-vaults`,
  `/v1/credential-vaults/{id}/credentials`, `/v1/memory_stores` and
  `/v1/memory_stores/{id}/memories`); the two windowed listings that carry a
  followable cursor (`/v1/skills` and both credential audit listings); plus the two
  listing routes that already used `cursorPageOf`
  (`/v1/memory_stores/{id}/memory_versions` and `/v1/sessions/{id}/resources`). The
  collections that still build their page with `pageOf` are named in §4.
- `cursorPageOf` takes `prev` from the caller rather than inferring it: a
  forward-only scan cannot know its predecessor, and inventing one would
  produce a cursor that does not resolve.
- `normalizeCollectionFilter` canonicalizes a filter (sorted keys, empty values
  dropped) so "the same query" is decided by the caller-visible meaning rather
  than by argument order, and `cursorQueryMismatch` is the single check a
  handler runs before honouring a cursor. Both live beside `encodeCursor` so a
  collection cannot invent its own comparison.
- No canonical collection handler builds its own pagination: a converted handler
  goes through `collectionPager`, and the two listing routes above go through
  `cursorPageOf` directly. The collections still on the local envelope are the gap
  recorded in §4 rather than an exception to the rule.

## 3. Alignment

Aligned for: canonical field names, cursor opacity at the API surface, the
prohibition on mixing both spellings in one response, cursor rejection on
malformed input, and rejection of a cursor replayed under a different ordering
or filter.

## 4. Differences

| Difference | Detail |
| --- | --- |
| Extension envelope | `/v1/x` collections return `{data, has_more, first_id, last_id}`. The published contract has no such envelope. |
| Collections still on the local envelope under `/v1` | `agents` (and its versions), `api-keys`, `environments` (and its worker keys), `files` and `sessions` are built with `pageOf`, so they carry `has_more` / `first_id` / `last_id` while the contract puts canonical collections on cursors. Converting one changes a public shape that the SDK types and the Console read, so it is scheduled collection by collection rather than as one wire break. |
| Null cursors on complete result sets | Most canonical collections return `next_page: null` and `prev_page: null` because the full set is returned unwindowed. A real cursor is produced when a collection is windowed — `/v1/sessions`, `/v1/sessions/:id/events`, `/v1/skills`, the credential audit listings and `/v1/memory_stores/{id}/memory_versions`. |
| Cursor payload visibility | SandBase cursors are readable base64url JSON, not opaque binary. They carry no secret, so the opacity is present to discourage construction rather than to conceal data. The published contract does not specify an encoding. |
| Cursor position is a page, not a sort key | `/v1/sessions` stores a 1-based page number, so the scan is redone from that page. A concurrent insert or delete shifts what a later page contains. A keyset cursor naming the last delivered row's sort key would not. The offset cursors (`/v1/skills`, the audit listings, the memory versions) have the same property for the same reason: the backing store pages by offset. |
| Cursor semantics are not uniform | Four shapes exist across the surface: `/v1/sessions` carries `{order, filter, page}`, `/v1/sessions/:id/events` carries `{session_id, after_id}`, `/v1/skills` and the audit listings carry `{offset, filter}`, and the remaining resource listings carry `{offset}` alone because they return everything in one page. All are canonical envelopes, but a cursor is only meaningful in the collection that issued it, which `cursorQueryMismatch` enforces where a filter is bound. |

`order` **is** bound, and since the filter binding was added it covers filters too:
`/v1/sessions` records the ordering and the normalized `agent_id` / `status` /
`include_archived` in every cursor it issues and rejects a replay that does not
match (`cursorQueryMismatch`). The remaining gap is the position scheme, not the
query binding.

## 5. Reason for the difference

- The extension envelope is retained because `/v1/x` is a local surface with
  existing consumers. The design rule is that migration happens in the client
  adapter, not by emitting both envelopes from the server — that is the failure
  mode where a client reads one field while the server paginates by another.
- Returning `null` cursors for a complete set is honest: a synthetic
  `next_page` would let a caller follow a cursor into an empty page.
- Readable cursors were chosen so a support engineer can diagnose a pagination
  bug locally. The trade-off is recorded because the published contract says
  "opaque" and readable JSON is not opaque in the cryptographic sense.
- A page-number position was kept because the only windowed collection today is
  `/v1/sessions`, whose backing store pages by offset. Converting it to a keyset
  cursor is a store-level change, so the deviation is recorded rather than
  implied. The filter binding was added because it is a pure handler-side check
  and its absence was a silent-corruption path, not a missing convenience.

## 6. Corresponding tests

- `tests/integration/api.test.ts` — `expectPage` asserts the local envelope for the
  collections §4 still lists; `expectCursorPage` asserts the canonical one for the
  collections that have moved, so which helper a path uses states where that
  collection stands rather than what this file finds convenient. The event-cursor
  cases pin the `after_id` behaviour and rejection of a cursor issued for another
  session. (An earlier revision of this document also credited the file with an
  `expectExtensionPage` helper; no such helper exists, and the `/v1/x` shape is
  asserted inline where it matters.)
- `tests/integration/operations-collection-envelope.test.ts` — the operations
  collections under `/v1` carry `{data, prev_page, next_page}` and none of the local
  field names; the `/v1/x` mirror carries the local four and neither cursor; an
  action that answers `202` with a collection keeps its status; and a nested
  collection follows the same rule as its parent.
- `tests/integration/resource-collection-envelope.test.ts` — the four collections
  that return their whole set carry exactly `{data, prev_page: null, next_page:
  null}`, the audit listings are asserted to carry a cursor once a `limit` cuts the
  trail, and the collections §4 names as unconverted are asserted to still return the
  local shape so the difference row cannot drift from the tree.
- `tests/integration/followable-cursor-collections.test.ts` — `/v1/skills` walks
  forward to a page that repeats no row and back through `prev_page`, refuses a
  malformed cursor and one issued for another `source`, and the credential audit
  listings reach an older event through `next_page`: a two-page trail reports `null`
  on the last page and a cursor on a cut one, which the local envelope could not
  express.
- `tests/integration/canonical-collection-envelope.test.ts` — enumerates every
  canonical collection and asserts the envelope, asserts the extension
  collections still use the local one, follows a cursor to a second page without
  repeating a row, and pins the filter binding in both directions (a different
  filter is rejected; the same filter, and an omitted filter equal to its
  default, are accepted).
- `tests/unit/cma-pagination-contract.test.ts` — cursor encode/decode round
  trips, malformed-cursor rejection, and the `prev`/`next` null semantics.
- `tests/unit/skill-resources.test.ts` — the resource collection that previously
  used a private page-offset cursor, now asserted against the shared contract,
  plus rejection of an invalid cursor.

## 7. Status

`partial` — canonical pagination is implemented and gated by tests for `/v1`,
every canonical collection is enumerated by a contract test, and cursors are
bound to both the ordering and the filter that produced them. The `/v1/x`
extension envelope, the null-cursor case, and the offset-based position scheme
are documented deviations rather than upstream behaviour.
