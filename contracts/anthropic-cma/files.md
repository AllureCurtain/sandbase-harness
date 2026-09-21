# CMA Contract — files

Contract area: `/v1/files` and file session resources.
Status: `supported`.
Source: `src/core/session/file-mount-path.js`,
`src/api/routes/session-resources.ts`, `src/core/session/session-resources.ts`.

---

## 1. Official definition

- Files are uploaded, listed, and read through the files API.
- A file can be attached to a session as a resource, mounted at a path inside
  the sandbox so the agent can read it.
- The mount path is a logical sandbox path, not a host path.

## 2. Current SandBase shape

Files API:

- Files are uploaded, listed, and read. A file resource carries its own identity
  and a `mount_path`.

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

## 3. Alignment

Aligned for: upload/list/read, resource attachment, canonical mount path form,
and independent resource identity.

## 4. Differences

| Difference | Detail |
| --- | --- |
| Resource identity | SandBase gives each session resource instance its own `sesrsc_` id. The published contract documents independent resource identity; the id prefix is a local spelling. |
| Deleting a running-session file resource | SandBase soft-deletes (`deleted_at`), so the record survives for audit while the resource stops being live. The published contract allows deletion without fixing the mechanism. |
| Mount root | SandBase mounts under its own sandbox root layout. The published contract specifies a logical path, not a host directory. |

## 5. Reason for the difference

- Independent resource ids exist so `PATCH`/`DELETE` can address one resource
  without rewriting the whole session payload. Rewriting an array to change one
  entry is how concurrent edits lose each other's changes.
- Soft delete keeps an audit trail: a resource that was attached to a session
  and later removed is a fact worth retaining, and a hard delete would erase
  the evidence that it was ever mounted.

## 6. Corresponding tests

- `tests/unit/file-mount-path.test.ts` — canonical mount path derivation and
  validation.
- `tests/unit/session-resource-instances.test.ts` — attach, list, delete, and
  independent id assignment against a real database.
- `tests/integration/api.test.ts` — adding and removing a file resource on a
  running session, and addressing a resource by its own id.

## 7. Status

`supported` — file upload/list/read, mount path handling, and running-session
file resource lifecycle are implemented and covered by tests.
