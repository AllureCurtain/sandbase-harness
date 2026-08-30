# SandBase Harness Showcase

SandBase Harness is useful when an agent needs a durable runtime boundary, not
just a single model request. These are three practical starting points.

## Find and verify the project

- [Current release: v0.3.8](https://github.com/sandbaseai/sandbase-harness/releases/tag/v0.3.8)
- [Official MCP Registry entry](https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.sandbaseai%2Fsandbase-harness)
- [Verified dshbase listing](https://dshbase.com/plugins/sandbase-harness/)
- [SandBase Agent Runtime landscape](https://github.com/sandbaseai/awesome-agent-runtime)

## 1. Auditable coding agent

Use persistent sessions, event streams, artifacts, snapshots, and replay when
you need to inspect what an agent did after a long-running task.

```bash
node ../sandbase-harness/dist/index.js init
node ../sandbase-harness/dist/index.js start
```

Open the Console at `http://127.0.0.1:3000/dashboard`, create an Agent, and
start a session. Use the session event endpoint or Console timeline to inspect
tool calls, results, status changes, and token usage.

Best for: coding assistance, research jobs, document generation, and workflows
where a human may need to review or resume the work.

## 2. DeepSeek Harness as the front end

Run Harness as a separate managed-agent runtime and connect it to DeepSeek
Harness through the bundled stdio MCP bridge. The DSH integration exposes
agent listing, session creation, streamed turns, artifact inspection, and
cancellation.

Follow the reproducible setup in
[`examples/deepseek-harness`](../examples/deepseek-harness/README.md). The
current tagged release is v0.3.8; use HTTPS Git URLs for cross-platform
installs.

Best for: using DSH as the interactive front end while keeping durable agent
execution, audit history, and sandbox policy in a separate runtime.

## 3. Controlled code execution

Choose the sandbox according to the trust boundary:

| Scenario | Provider | Boundary |
| --- | --- | --- |
| Trusted local development | `local` | Same OS user; not isolated |
| Untrusted or generated code | `docker` | Per-session container and resource limits |
| Cluster-managed workloads | `kubernetes` | Pod and RBAC boundary |
| Separate execution service | `self_hosted` / `remote` | Worker queue and off-host execution |

For production exposure, enable bearer authentication, use a persistent data
directory, put the runtime behind TLS, and keep provider credentials in an
environment or secret manager. See [Deployment Examples](deployment.md).

## What to share when asking for help

Include the Harness version, Node.js version, operating system, model provider,
sandbox provider, the relevant endpoint or CLI command, and the exact error.
Remove API keys, credentials, personal paths, and private session content.

Useful references:

- [Installation](installation.md)
- [Usage Guide](usage.md)
- [DeepSeek Harness integration](../examples/deepseek-harness/README.md)
- [GitHub Discussions](https://github.com/sandbaseai/sandbase-harness/discussions)
