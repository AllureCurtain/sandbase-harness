# CMA Contract — memory stores

Contract area: `/v1/memory_stores` — stores, memories, scoping, limits,
preconditions, and versions.
Status: `supported`.
Source: `src/core/memory/semantics.ts`, `src/api/routes/memory-stores.ts`,
`src/core/db/migrations.ts`.

<!-- capability-status
memory-crud: supported
memory-limits-and-preconditions: supported
memory-version-audit: supported
memory-multi-mount: supported
-->

---

## 1. Official definition

- A memory store holds named memories. A session may mount one or more stores.
- `access` is `read_write` (default) or `read_only`.
- Listing memories supports `path_prefix` and `depth` scoping.
- Limits: one memory ≤ 100 kB, one store ≤ 10,000 memories, one session ≤ 8
  stores, `instructions` ≤ 4,096 characters.
- A write may assert a content precondition so a caller cannot overwrite content
  it did not read.
- Each write is auditable as a version.
- Store memory endpoints use the `agent-memory-2026-07-22` beta.

## 2. Current SandBase shape

Constants (`semantics.ts`):

| Limit | Value |
| --- | --- |
| `MAX_MEMORY_CONTENT_BYTES` | 102,400 (100 kB) |
| `MAX_MEMORIES_PER_STORE` | 10,000 |
| `MAX_MEMORY_STORES_PER_SESSION` | 8 |
| `MAX_MEMORY_INSTRUCTIONS_CHARS` | 4,096 |
| `DEFAULT_MEMORY_ACCESS` | `read_write` |

Scoping:

- `path_prefix` must start **and** end with `/`. This is enforced rather than
  normalized, because `/notes` and `/notes/` match different sets and silently
  fixing one to the other would change which memories a caller sees.
- Matching is by path segment: `/notes/` matches `/notes/todo.md` and
  `/notes/archive/old.md`, and does **not** match `/notes-archive/todo.md`.
- `depth` accepts only `0` or `1`; any other value is a 400 rather than being
  coerced to a nearest legal value.

Preconditions:

- A write may carry a `content_sha256` precondition. A mismatch returns 409
  `precondition_failed` with the current hash, so the caller can retry against
  the real state instead of guessing.
- The hash is computed over UTF-8 bytes, matching what `memoryContentBytes`
  measures for the size limit, so the two checks cannot disagree.

Multiple stores per session:

A session may attach up to `MAX_MEMORY_STORES_PER_SESSION` stores, each with its
own `mount_path`, `instructions`, and `access`. Three surfaces consume the same
resolution rather than each deriving their own view:

| Surface | What it reads |
| --- | --- |
| `ContextBuilder` | The prompt sections, one per attached store, using that store's `instructions` |
| Memory API | Reads and writes routed to the store whose `mount_path` prefixes the memory path |
| Sandbox file tools | The mount paths that must be protected under a `read_only` store |

`resolveMemoryBindings` (`src/core/memory/bindings.ts`) is the single source of
truth for that resolution. A surface that re-derived the bindings could disagree
about which store owns a path, and the disagreement would surface as a write
landing in the wrong store.

`read_only` is enforced at the tool layer, not merely declared:
`buildSandboxTools(..., memoryMounts)` receives the bindings and blocks a call
before it is executed —

- `write` and `edit` are refused when the target path is inside a `read_only`
  mount (`pathInMount`);
- `bash` is refused when the command names a path inside a `read_only` mount
  (`commandNamesPath`), since a shell redirect would otherwise write there;
- a `read_write` mount is left unguarded, and a session with no store attached
  changes nothing about tool behaviour.

The enforcement lives at the tool layer because that is the only place that sees
the path before the sandbox does. A check performed later would have to undo a
write that already happened.

Audit:

- Every memory write records a row in `memory_versions`, listable per store and
  readable per version.

Mounting:

- A store mounts at `/mnt/memory/<slug>/`, where `slug` is the store name
  lowercased with non-alphanumeric runs collapsed to a single hyphen; a name
  with no usable characters falls back to `memory`.
- A memory store can only be attached when the session is created. Attaching one
  to a running session is refused, because memories are part of the context the
  session was built with.

## 3. Alignment

Aligned for: all four published limits, `access` default and values, the
`path_prefix` requirement, `depth` values, `content_sha256` preconditions, and
per-write version auditing.

## 4. Differences

| Difference | Detail |
| --- | --- |
| Precondition status | A mismatch is a 409 `precondition_failed`. The published contract states the precondition concept without fixing the status pairing. |
| Version retention | SandBase records versions in its own table. The published contract requires auditability without fixing a storage shape. |
| Slug fallback | A store name with no alphanumeric characters mounts at `/mnt/memory/memory/`. The published contract documents the slug rule but not this edge case. |

## 5. Reason for the difference

- 409 was chosen over 400 because the request was well-formed; the stored state
  had moved. A 400 would tell the caller to fix their request, which is the
  wrong next action.
- The slug fallback exists so a store with a punctuation-only name still mounts
  somewhere predictable rather than at `/mnt/memory//`, which would be an
  invalid path.

## 6. Corresponding tests

- `tests/unit/memory-semantics.test.ts` — 36 cases: byte and character limits,
  segment matching, `depth` values, precondition evaluation, slug generation,
  and mount path derivation.
- `tests/unit/memory.test.ts` — store and memory CRUD.
- `tests/integration/api.test.ts` — the memory beta mutual-exclusion rule and
  the at-creation attachment rule for session resources.
- `tests/integration/memory-mounts.test.ts` — the multi-store behaviour: several
  stores bound at once with the longest nested mount winning and a lookalike
  workspace path staying an ordinary workspace path, each store read back through
  its own binding, `read_only` blocking `write` / `edit` / `bash` at the tool
  layer (including a literal `//mnt/memory/...` path) while leaving a
  `read_write` mount unguarded, an absent provider failing closed, and the
  ContextBuilder searching every bound store while extraction reaches only the
  writable ones.
- `tests/integration/memory-wiring.test.ts` — the legacy `context_id` memory path
  still injects its own section, so the resource-scoped path did not replace it.

## 7. Status

`supported` — limits, scoping, preconditions, version auditing, multi-store
mounting, and tool-layer read-only enforcement are implemented and covered by
tests.
