# CMA Contract — files

Contract area: `/v1/files` and file session resources.
Status: `partial` — the Files API and the mount-path form are implemented, but a
session's file resources are not mounted by any runtime composition. See §4.
Source: `src/core/session/file-mount-path.ts`,
`src/api/routes/session-resources.ts`, `src/core/session/session-resources.ts`,
`src/api/routes/files.ts`.

<!-- capability-status
file-resources: partial
file-mount-path: supported
-->

---

## 1. Official definition

- Files are uploaded, listed, and read through the files API.
- A file can be attached to a session as a resource, mounted at a path inside
  the sandbox so the agent can read it.
- The mount path is a logical sandbox path, not a host path.

## 2. Current SandBase shape

The mount-path rules are `src/core/session/file-mount-path.ts`; the resource
lifecycle is `src/core/session/session-resources.ts` and its route is
`src/api/routes/session-resources.ts`.

Files API:

- Files are uploaded, listed, and read. A file resource carries its own identity
  and a `mount_path`.
- The listing honours the published `scope_id` parameter: `scope_id` selects the
  column's local `session_id`, so a caller asking for one session's deliverables
  gets that session's files and nothing else. The scope is applied in the query
  rather than filtered after the read, so an id that names no session returns an
  empty page instead of the global list — an ignored scope answering with the
  unscoped list is the specific failure the parameter exists to prevent, and it
  is indistinguishable from a session that happens to have unfamiliar files.
- A list without `scope_id` returns every file, which is what this route returned
  before the parameter was implemented, so no existing caller changes. A
  parameter outside `scope_id` is refused by name rather than ignored. See
  [`errors.md`](./errors.md) §2.

Mount path:

- `canonicalPathFromSandboxPath` produces the canonical form, and the mount path
  is validated on the way in as well, so a caller cannot store a path the
  runtime would not accept on read.

Session file resources:

- A file resource attached to a session gets its own `sesrsc_` id, so it can be
  addressed independently of the session's resource JSON blob.
- On a running session, file resources may be added, listed, and deleted. This
  differs from `memory_store` (creation-only) and `github_repository` (token
  rotation only).

Mounting is the part that is not wired:

- `SandboxLifecycle.materializeFileResources` writes each attached file into the
  sandbox by calling an injected `fileArtifactReader`, and throws
  `File session resources require an artifact reader` when that dependency is
  absent. Nothing in `src/` supplies it: `createRuntimeSessionServices` and
  `DefaultSessionExecutor` pass no reader, and the only callers that do are
  tests. A session created with a file resource therefore succeeds and then
  fails on its first turn, rather than failing at creation with the dependency
  named.

## 3. Alignment

Aligned for: upload/list/read, the scoped listing, resource attachment, canonical
mount path form, and independent resource identity.

## 4. Differences

| Difference | Detail |
| --- | --- |
| Resource identity | SandBase gives each session resource instance its own `sesrsc_` id. The published contract documents independent resource identity; the id prefix is a local spelling. |
| Deleting a running-session file resource | SandBase soft-deletes (`deleted_at`), so the record survives for audit while the resource stops being live. The published contract allows deletion without fixing the mechanism. |
| Mount root | SandBase mounts under its own sandbox root layout. The published contract specifies a logical path, not a host directory. |
| What a scoped listing contains | `scope_id` selects files whose recorded session is that session. A file created directly through `POST /v1/files` records no session, so it appears in the unscoped listing and in **no** scoped one — it is not attributed to a session that did not create it. The published contract describes session outputs; it does not state where a session-less upload should appear, so the choice is to leave it unattributed rather than guess an owner. |
| The listing excludes `role = 'artifact'` | Rows written with `role = 'artifact'` are outside this listing in both scoped and unscoped form. That predates the scope parameter and is unchanged by it; recorded here because a caller reasoning about "every file for this session" should know the listing is not the whole table. |
| Mounting is not composed | The mount path is derived and validated, but no runtime composition injects the artifact reader the provisioning pass needs, so an attached file is not written into the sandbox and the first turn fails. Recorded as `partial` rather than `supported` until the composition root supplies the reader. |

## 5. Reason for the difference

- Independent resource ids exist so `PATCH`/`DELETE` can address one resource
  without rewriting the whole session payload. Rewriting an array to change one
  entry is how concurrent edits lose each other's changes.
- Soft delete keeps an audit trail: a resource that was attached to a session
  and later removed is a fact worth retaining, and a hard delete would erase
  the evidence that it was ever mounted.
- The reader is injected rather than imported so the lifecycle stays free of
  host storage concerns, and a test can attach a fixture file. That choice is
  what makes the missing production wiring a configuration gap instead of a
  compile error, which is why the entry is `partial` and not `supported`: the
  code path exists, but a caller cannot reach it from a started runtime.

## 6. Corresponding tests

- `tests/unit/file-mount-path.test.ts` — canonical mount path derivation and
  validation.
- `tests/unit/session-resource-instances.test.ts` — attach, list, delete, and
  independent id assignment against a real database.
- `tests/integration/api.test.ts` — adding and removing a file resource on a
  running session, and addressing a resource by its own id.
- `tests/integration/session-resources.test.ts` — the provisioning pass that
  writes an attached file into the sandbox: the canonical mount path under
  `/mnt/session/uploads`, a legacy pre-canonical row, the write happening after a
  snapshot restore and exactly once per bound sandbox, and a traversal path
  cleaning up the failed provision. The reader is injected by the test, which is
  precisely the dependency a runtime composition does not supply.
- `tests/integration/files-scope-id.test.ts` — the scoped listing: one session's
  files are returned and another's are not (asserted in both directions, so the
  case cannot pass by the filter always selecting the same session), an unknown
  scope returns an empty page rather than the global list, a session-less file is
  absent from every scoped listing, an unscoped request keeps the previous global
  listing, an unimplemented parameter is refused by name, and the compatibility
  gate still refuses an ungated request that carries a scope.

## 7. Status

`partial` — file upload/list/read, mount path derivation, resource identity, and
the running-session resource lifecycle are implemented and covered by tests,
while mounting an attached file into a session's sandbox is not reachable from a
started runtime. The mount-path entry is `supported` on its own, because path
derivation and validation are complete and tested.
