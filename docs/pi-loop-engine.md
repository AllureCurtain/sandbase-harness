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
rejected by Settings rather than failing their first turn. The user prompt is
written on stdin and stdin is then closed; it is never added to command
arguments. Pi's `models.json` is written under the session's private Pi config
directory with restrictive file permissions where supported. It defines a
managed `sandbase` provider with the selected model and matching OpenAI or
Anthropic API kind, and contains only the `$SANDBASE_PI_API_KEY` credential
reference. Pi stdout is consumed as bounded LF-delimited JSONL without `readline`. The
adapter validates documented event shapes, strips structured tool markup across
chunk boundaries, and appends final text, thinking, native tool use/result,
model spans, and terminal events to the same SQLite EventLogger used by the
builtin engine. Every durable event is appended before it is broadcast. Text
deltas have `seq: 0` and are live-only; the final `agent.message` is the replay
authority. Each Pi model request records usage exactly once. Unknown events are
inert, malformed authority-bearing events fail the turn, and stderr is limited
to a redacted 64 KiB diagnostic tail.

Pi must be installed and discoverable as `pi`; the Settings test reports a
missing CLI and a turn fails explicitly if it cannot be launched. On Windows,
the npm `pi.cmd` shim is invoked through its neighbouring `pi.ps1` script with
a fixed PowerShell argument forwarder, rather than a shell command string.

Pi children receive the session abort signal. An interrupt, stop, delete, or
runtime shutdown waits for the launched Pi process tree to exit before the
session work directory can be released; on POSIX the child runs in its own
process group, and on Windows the session waits for `taskkill` to finish
terminating the process tree.

## Current scope and boundaries

The current print-mode adapter produces durable CMA events and visible Pi-native
tool trajectory. Native Pi tools are not Harness `ToolResolver` tools: they do
not receive Harness `always_ask` approval, local file path confinement, or a
fake Allow/Deny card. Foundation policy still rejects agents declaring
`always_ask`, `never_allow`, or disabled tools. Pi session-file leases,
resume/recovery continuity, turn deadlines, and stronger cleanup states remain
the next continuity work package. Docker/Kubernetes Pi transport, RPC, and a
Pi→Harness approval bridge remain excluded. It also adds no OpenAI API surface.

Pi recognizes `models.json` provider settings and resolves `$ENV_VAR` values
at request time; this is why the per-session config references
`$SANDBASE_PI_API_KEY` rather than serializing a credential. See the upstream
[Pi custom models documentation](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/models.md).
