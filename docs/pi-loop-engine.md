# Pi Loop Engine Foundation

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
reference. The resolved model key is passed in a restricted child environment;
telemetry is disabled with `PI_TELEMETRY=0`.

Pi must be installed and discoverable as `pi`; the Settings test reports a
missing CLI and a turn fails explicitly if it cannot be launched. On Windows,
the npm `pi.cmd` shim is invoked through its neighbouring `pi.ps1` script with
a fixed PowerShell argument forwarder, rather than a shell command string.

Pi children receive the session abort signal. An interrupt, stop, delete, or
runtime shutdown waits for the launched Pi process tree to exit before the
session work directory can be released; on POSIX the child runs in its own
process group, and on Windows the session waits for `taskkill` to finish
terminating the process tree.

## Foundation scope

This is deliberately a process-launch foundation, not a Pi protocol adapter.
Pi JSON output is not translated into Harness events yet. It does not implement
Pi session resume locking/continuity, skills CLI arguments, markup filtering,
usage aggregation, turn timeouts, Docker Pi images, RPC, or a Pi
tool-confirmation protocol adapter. CMA supports richer user content and event
forms, but this print-mode foundation admits only text `user.message` turns and
`user.interrupt` control events; image/document messages, custom-tool results,
and tool confirmations are rejected before persistence or child execution. Use
the built-in engine when an integration requires those CMA features. Because
print mode has no verified Harness tool-policy bridge, agents that declare
`always_ask`, `never_allow`, or disabled tools are rejected at Pi session
creation and before execution or resume; none of those restrictions can
silently bypass Harness policy. It also adds no OpenAI API surface.

Pi recognizes `models.json` provider settings and resolves `$ENV_VAR` values
at request time; this is why the per-session config references
`$SANDBASE_PI_API_KEY` rather than serializing a credential. See the upstream
[Pi custom models documentation](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/models.md).
