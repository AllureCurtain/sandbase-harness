# Roadmap

This public roadmap tracks product work for `managed-agents`. It describes
project-owned features only.

## Near Term

- Improve API compatibility coverage and documented response shapes.
- Add end-to-end dashboard tests for session creation, messaging, event replay,
  and error states.
- Add SDK helpers for common chat and inspection workflows.
- Add CLI session commands for create, list, message, tail, logs, and inspect.
- Improve template validation and authoring commands.
- Add richer runtime metrics for model usage, tool duration, and session state.

## Runtime

- Add tool confirmation flow for sensitive actions.
- Add client-side custom tool support.
- Add optional workspace snapshots for file-system recovery.
- Add optional long-term memory provider support.
- Expand context-window metadata and compaction controls.
- Improve graceful shutdown reporting for in-flight turns.

## Sandboxes

- Harden local sandbox defaults. The local backend has path confinement and an
  environment allowlist but no kernel boundary; add OS-level isolation
  (`sandbox-exec` on macOS, `bubblewrap` on Linux) so `local` can declare
  `isolatedExecution`.
- Expand Docker examples and resource-limit coverage.
- Run the Kubernetes live-cluster suites in CI. They exist and pass against a
  real cluster, but they skip when no cluster is reachable, so nothing currently
  enforces them. See CONTRIBUTING.md for how to run them locally.
- Handle Pod eviction and node pressure mid-session. Provision now fails fast on
  terminal image and config errors, but a Pod evicted after a session is running
  surfaces only as command failures.
- Add network egress controls per Environment for the container backends.
- Add incremental command output (`streamingExec`) once a consumer exists for
  it: today tool results reach the model as a single value, so the capability is
  declared and reported as unsupported rather than implemented.
- Improve self-hosted worker ergonomics.
- Add provider packages for additional isolated execution backends.

## Dashboard

- Bring `apps/console` under type checking and repair what that surfaces.
  `npm run typecheck` covers `src` and the runtime test suite; the Console is a
  third program that has never been checked, and it currently reports ~90
  errors. Some are missing type members, but several are references to names
  that are never imported (`useEffect`, `formatDateShort`, `putJson`, and
  several icon components), which throw when the containing component renders.
- Decide which Console composition root is canonical. `main.tsx` renders
  `App.tsx`, which imports `components/pages/MemoryStorePages` and
  `components/modals/*`; `components/ConsoleRoutes.tsx` is a parallel router
  that nothing renders, and it imports a different lineage
  (`components/pages/MemoryPages`). The Console tests exercise the lineage that
  does not ship, so page-level coverage does not protect what users load. This
  looks like an unfinished module split rather than an intentional split.
- Add clearer error and reconnect states.
- Add session delete and stop actions.
- Add event filtering in the trajectory view.
- Add model, skill, and MCP status panels.
- Add read-only configuration inspection.

## CLI and SDK

- Add session lifecycle subcommands.
- Add model and environment inspection commands.
- Add richer SDK examples.
- Add typed helpers for event filtering and replay cursors.

## Documentation

- Keep public documentation in English.
- Keep public documentation focused on this project.
- Keep public documentation focused on release-facing project behavior.
- Add deployment guides after the runtime behavior is stable.
- Add a versioned compatibility matrix before the first stable release.
