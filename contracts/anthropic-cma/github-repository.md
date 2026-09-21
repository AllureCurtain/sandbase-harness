# CMA Contract — github-repository

Contract area: the `github_repository` session resource — cloning a repository
into the sandbox, checking out a ref, discovering the skills it ships, and
keeping the access token out of everything the model can read. Status:
`supported`, see §7. Source: `src/core/resources/github-materializer.ts`,
`src/core/resources/github-runtime.ts`,
`src/core/session/sandbox-lifecycle.ts`, `src/core/runtime/session-runtime.ts`,
`src/core/session/executor.ts`, `src/core/session/context-builder.ts`.

---

## 1. Official definition

A session may attach a `github_repository` resource naming a repository URL, an
optional checkout ref, and a mount path. The runtime materializes the repository
into the session's filesystem so the agent can read it, and any skills the
repository ships become available to the agent. The access token used for the
clone is a credential, not part of the resource: it must not be observable by the
model, persisted in an event, or echoed into a log.

## 2. Current SandBase shape

`materializeGithubRepository(resource, sandbox, deps)` runs a five-phase
sequence, and every phase has a defined failure disposition:

1. **Validate and decrypt.** The URL must parse as
   `https://github.com/<owner>/<repo>` — `parseGithubRepositoryUrl` rejects
   `http://`, SSH, a `.git` suffix, and any query or fragment. The token is
   resolved through `resolveGithubToken`, reading the credential store rather
   than the resource.
2. **Reuse the cache when the ref allows it.** `githubCacheKey(url, checkout)`
   returns a key only for a `commit` checkout: `sha256(url\nsha)` truncated to 32
   characters. A branch or tag cannot be cached, because the same name resolves
   to a different commit over time and a cached checkout would silently serve a
   stale tree.
3. **Clone and check out.** `cloneArgs(url, checkout)` builds the argument list;
   the token is passed through the environment (`gitAuthEnv`) as a GitHub
   `Authorization: Basic` header using the `x-access-token` user, never as an
   argv element. The header value is base64-encoded, so the plaintext token is
   not present in the child process environment either. `GIT_TERMINAL_PROMPT=0`
   and an empty `GIT_ASKPASS` ensure git cannot block on or fall back to an
   interactive prompt.
4. **Discover skills before copying.** `discoverRepositorySkills(repoRoot, deps)`
   scans `.claude/skills/<name>/SKILL.md`. The scan runs against the staging
   clone rather than the mounted copy so a skill that must not be exposed cannot
   be reached through a half-copied tree.
5. **Write into the sandbox.** The tree is copied (with `.git` excluded) to the
   resolved mount path, and the discovered skills are registered as the session's
   repository skills.

Failure disposition is the part that is easy to get wrong:

- A failed phase deletes the staging directory. Nothing is left behind on disk
  for a session that never started.
- Token hygiene is enforced by `sanitizeGitOutput(text, token)`, which strips the
  token from git's own stdout/stderr before the message is turned into an error.
  `skillPathsAreTokenFree(paths, token)` asserts the discovered skill paths do
  not embed the token.
- Output is capped at `MAX_OUTPUT_CHARS = 4_000` before it reaches an error
  message, and every git invocation has a timeout of `GIT_TIMEOUT_MS = 120_000`;
  a timed-out git reports exit code `124`.
- `mountIdentityChanged(prev, next)` reports whether a running session's
  repository identity has moved. Changing the URL, the checkout, or the
  mount path requires a **new session**: the skills that were registered and the
  files the agent may already have read cannot be retroactively corrected
  mid-run.

Runtime wiring is real rather than a helper that exists but is never called:
`SessionRuntime` constructs the materializer via
`createGithubMaterializer({ cacheRoot: artifactStore.path('cache'), dataDir:
credentialDataDir })`; `SandboxLifecycle` calls it during provisioning;
`ExecutorDeps.githubMaterializer` passes it through; and
`ContextBuilderDeps.repositorySkills` reads
`sandboxLifecycle.discoveredRepositorySkills(sessionId)` — the single source of
truth for repository skills — so the prompt sees exactly the skills that were
discovered.

## 3. Alignment

Aligned for: the resource being declarable per session, the repository being
present in the sandbox at a known path, shipped skills becoming agent-visible,
and the token never being model-visible or persisted.

## 4. Differences

| Difference | Detail |
| --- | --- |
| URL grammar | Only `https://github.com/<owner>/<repo>` is accepted. A self-hosted GitHub Enterprise host, an SSH remote, and a `.git` suffix are rejected rather than silently normalized. |
| Cache scope | Only a `commit` checkout is cacheable. A branch or tag checkout always clones fresh, trading time for the guarantee that the tree matches the ref. |
| Mount path | The canonical mount path is produced and validated locally; see [`files.md`](./files.md) for the path form itself. |
| Skill discovery path | `.claude/skills/<name>/SKILL.md` is the discovery convention. A repository using a different layout exposes no skills, which is reported rather than guessed at. |
| Live mutation | Changing URL, checkout, or mount path mid-session is refused; a new session is required. |

## 5. Reason for the difference

- Restricting the URL grammar is a security decision: accepting an arbitrary git
  remote would turn a resource declaration into an arbitrary-code-fetch
  primitive, and SSH remotes would require key material the runtime does not
  manage. A rejected URL fails before any clone begins.
- Not caching branch checkouts is the honest reading of what a cache key means.
  A branch name is not an identity, so caching on it would make correctness
  depend on how recently the cache was populated.
- Refusing a live identity change is a consequence of skills being registered at
  provisioning: the session's prompt has already named the discovered skills, and
  the agent may have read files from the old tree. Silently swapping the tree
  would leave the prompt describing something that is no longer there.
- Passing the token through the environment rather than argv is not a stylistic
  choice: on many systems argv is world-readable through the process table, so an
  argv token is a token disclosed to every local process.

## 6. Corresponding tests

- `tests/unit/github-materialization.test.ts` — decision logic: the URL grammar,
  cache-key scope (commit only), clone argument construction, token-bearing
  environment rather than argv, output sanitization, skill discovery, mount
  identity comparison, and the failure paths that must clean up staging.
- `tests/integration/github-materialization-real.test.ts` — the host-side
  primitives against a real `git` binary: clone, checkout, cache reuse, timeout
  behaviour, and that the token never appears in the captured output.
- `tests/unit/runtime-session-runtime.test.ts` — the wiring: a github
  materializer is constructed and mounts a repository during provisioning, so the
  capability is reachable from a started runtime rather than only from a direct
  function call.

**What these tests do not cover:** the decision and host-layer suites use local
fixtures for most cases. A live smoke verification was also run on 2026-09-18
against `https://github.com/AllureCurtain/sandbase-harness` at `main`: the
production materializer cloned the branch, mounted 343 files into the sandbox
adapter, discovered no repository skills, and left no token in the mount or
reported result. Provider-side edge cases such as rate limiting, credential
rejection, LFS, submodules, and GitHub Enterprise remain unverified.

## 7. Status

`supported` for the local behaviour: implemented end to end and exercised by
tests at both the decision layer and the host layer, with runtime wiring covered
by a composition test. A live smoke verification against one GitHub repository
and branch passed on 2026-09-18; provider-side edge cases remain unverified.
The cache-key scope and URL grammar are documented deviations, recorded in §4.
