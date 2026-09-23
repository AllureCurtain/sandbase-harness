# Pi Loop Engine (print/JSON)

Set `loop_engine.provider` to `pi` to select the external Pi CLI for **new**
sessions. The selected provider is persisted on each session: later global
settings changes only affect sessions created after the change. Existing
sessions continue to resolve their stored engine.

For one text `user.message` turn, the current foundation launches exactly one
print-mode child process:

```text
pi -p --mode json --model sandbase/<selected-model> --session <dataDir>/pi-sessions/<safe-session-id>.jsonl
```

The selected agent model is resolved from the active model configuration for
that turn. Its API key and base URL placeholders are resolved from the host
Settings environment before Pi starts; only the dedicated API-key alias enters
the restricted child environment. The private session file is pre-created
before its path is passed to Pi. The already-composed system/skills prompt is
written to `AGENTS.md` in the sandbox work directory before launch.

The process runs with the session sandbox's host work directory as its current
working directory. Therefore the Pi foundation currently requires the **local**
sandbox provider; Docker, Kubernetes, and self-hosted sandbox pairings are
rejected by Settings. The user prompt is written on stdin and stdin is then
closed; it is never added to command arguments. Explicit agent skills are passed
as one managed `--skill` flag per directory. Pi's `models.json` is written under
the session's private Pi config directory with restrictive file permissions and
contains only the `$SANDBASE_PI_API_KEY` credential reference.

Pi stdout is consumed as bounded LF-delimited JSONL without `readline`. The
adapter validates documented event shapes, strips structured tool markup across
chunk boundaries, and appends final text, thinking, native tool use/result,
model spans, and terminal events to the same SQLite EventLogger used by the
builtin engine. Every durable event is appended before it is broadcast. Text
deltas have `seq: 0` and are live-only; the final `agent.message` is the replay
authority. Each Pi model request records usage exactly once. Unknown events are
inert, malformed authority-bearing events fail the turn, and stderr is limited
to a redacted 64 KiB diagnostic tail.

Pi children receive the session abort signal. An interrupt, stop, delete, or
runtime shutdown waits for the launched Pi process tree to exit before the
session work directory can be released; on POSIX the child runs in its own
process group, and on Windows the session waits for `taskkill` to finish
terminating the process tree. If tree ownership cannot be confirmed before the
cleanup deadline, the session becomes `cleanup_pending` and the workspace is
retained. Timeouts become `timed_out`; Pi cancellation becomes `cancelled`.

Pi must be installed and discoverable as `pi`; the Settings test reports a
missing CLI and a turn fails explicitly if it cannot be launched. On Windows,
the npm `pi.cmd` shim is invoked through its neighbouring `pi.ps1` script with
a fixed PowerShell argument forwarder, rather than a shell command string.

The adapter now holds a cross-runtime lease beside the managed session file for
this entire child lifetime. A live owner returns a retryable `pi_session_busy`
error; an expired owner is recovered with an observable continuity notice. A
non-empty file must match the SQLite `pi_session_state` header id/schema/path,
otherwise resume is refused rather than silently forking. A Pi resume refusal
from stderr is persisted as `pi_resume_refused` and remains visible.

## Current scope and boundaries

The current print-mode adapter produces durable CMA events and visible Pi-native
tool trajectory. Native Pi tools are not Harness `ToolResolver` tools: they do
not receive Harness `always_ask` approval, local file path confinement, or a
fake Allow/Deny card. A declared policy is compiled into Pi's own vocabulary
instead — `--tools` for the enabled
set, `--exclude-tools` for a tool denied by `never_allow` or `enabled: false`, and
`--no-builtin-tools` when no native tool is left — and a declaration with no
faithful expression is refused with `pi_tool_policy_not_supported`, whose message
now names the declaration that caused it. The launch sends those flags, so a denied
or disabled tool is enforced by the child rather than promised by the admission
check, and an agent that states no policy at all is launched with
`--no-builtin-tools` rather than with Pi's default toolset. `always_ask` is still
refused: the gate that would ask is its own change. A fully disabled `mcp_toolset` is admitted
instead of refused, because nothing is expected to run through it and Pi has no
MCP transport to enforce: that is a correction of the earlier blanket refusal of
any `enabled: false` entry, and it makes no tool available. Continuity is guarded
by the managed lease and SQLite header state; a failed proof remains visible and
cannot silently fork history. Docker/Kubernetes Pi transport, RPC, and a Pi→Harness approval bridge remain
excluded. It also adds no OpenAI API surface.

Pi recognizes `models.json` provider settings and resolves `$ENV_VAR` values
at request time; this is why the per-session config references
`$SANDBASE_PI_API_KEY` rather than serializing a credential. See the upstream
[Pi custom models documentation](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/models.md).
