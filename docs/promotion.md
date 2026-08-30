# Promotion status

Last checked: 2026-08-30

This is an operational handoff for maintainers. The repository, release tags,
and official MCP Registry remain the source of truth; independent directories
do not imply endorsement or security review.

Latest follow-up: Open Source Radar issue #7 remains open with no maintainer
reply after the factual evidence update. Docker MCP Registry PR #4838 remains
open and review-gated (`REVIEW_REQUIRED`/`BLOCKED`); its maintainer note records
both the repository validator and the v0.3.8 MCP `initialize` handshake.

The MCP Registry publish workflow was re-run after the metadata description
update: image verification, metadata validation, and GitHub OIDC authentication
passed, but the Registry rejected the publish because version `0.3.8` already
exists (`cannot publish duplicate version`). The improved `server.json` will be
published with the next genuine release; no artificial version was created
([initial validation run](https://github.com/sandbaseai/sandbase-harness/actions/runs/33311700959),
[duplicate-version run](https://github.com/sandbaseai/sandbase-harness/actions/runs/33311736860)).

MCP.Directory's submission endpoint reports that this repository has already
been submitted; no public detail page is available yet, so it remains review-
controlled rather than verified discovery.

The latest public handoff is recorded in [Discussion #82](https://github.com/sandbaseai/sandbase-harness/discussions/82#discussioncomment-18207151).

The bilingual Showcase quickstart was locally verified with `npm ci` and
`npm run build`; runtime, MCP bridge, and Console artifacts all built
successfully.

## Verified public discovery

- [Official MCP Registry](https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.sandbaseai%2Fsandbase-harness)
- [GitHub repository topics](https://github.com/sandbaseai/sandbase-harness/topics): refreshed with `agentic-ai`, `agent-framework`, `agent-harness`, runtime, MCP, sandbox, and self-hosted discovery terms.
- [v0.3.8 Release Notes](https://github.com/sandbaseai/sandbase-harness/releases/tag/v0.3.8): now includes verified dshbase discovery, the official Showcase, and community self-hosting guides for release-page visitors.
- [Project Discussion #82](https://github.com/sandbaseai/sandbase-harness/discussions/82#discussioncomment-18207151): latest distribution update records the AgentSpot and AgentMatter submissions, Backblaze review path, recent source-backed community replies, and the distinction between pending and verified discovery.
- [Official DeepSeek Harness Showcase](https://github.com/deepseek-ai/deepseek-harness/discussions/1918): project showcase thread; the latest update records the Docker, ToolSDK, and TensorBlock review entries alongside the current v0.3.8 bridge/install links ([comment](https://github.com/deepseek-ai/deepseek-harness/discussions/1918#discussioncomment-18207245)).
- [DeepSeek Harness security discussion](https://github.com/deepseek-ai/deepseek-harness/discussions/5068#discussioncomment-18202943): answered a user asking how to prevent third-party APIs or plugins from reaching the host filesystem, with factual sandbox, approval, least-privilege, audit, and negative-test guidance plus the Harness reference implementation.
- [DeepSeek Harness memory discussion](https://github.com/deepseek-ai/deepseek-harness/discussions/14#discussioncomment-18202967): explained safe separation of imported preferences, workspace context, transcripts, credentials, and tool permissions, and linked the runnable Harness reference for users evaluating memory migration.
- [DeepSeek Harness plugin fault-isolation discussion](https://github.com/deepseek-ai/deepseek-harness/discussions/5106#discussioncomment-18206771): contributed a two-layer Host/runtime boundary and recovery checklist for users evaluating third-party plugins, with the Harness bundle and installation-recovery references.
- [DeepSeek Harness model-vs-runtime discussion](https://github.com/deepseek-ai/deepseek-harness/discussions/5115#discussioncomment-18206808): explained how to separate model, tool-contract, runtime, and evidence-boundary failures, using the Harness sessions, sandbox, memory, approvals, audit, and replay layers as a concrete reference.
- [DeepSeek Harness Agent scope discussion](https://github.com/deepseek-ai/deepseek-harness/discussions/5112#discussioncomment-18206821): shared the Agent-definition and Session-version-snapshot model for independent prompts, tools, skills, MCP servers, and permission boundaries, with API and DeepSeek integration references.
- [DeepSeek Harness reasoning-only stop discussion](https://github.com/deepseek-ai/deepseek-harness/discussions/5113#discussioncomment-18206832): explained the distinction between provider stop signals and user-visible deliverables, and linked the Harness event model that separates reasoning, messages, tool calls, and replay evidence.
- [DeepSeek Harness headless resume discussion](https://github.com/deepseek-ai/deepseek-harness/discussions/5109#discussioncomment-18206836): shared the Session resume, event-stream replay, and MCP attachment model with explicit boundaries, while distinguishing the existing Harness API from a future DSH `--resume` command.
- [DeepSeek Harness session-log recovery discussion](https://github.com/deepseek-ai/deepseek-harness/discussions/5103#discussioncomment-18206841): shared the durable-seq versus transient-chunk boundary and orphaned-tool recovery model, with architecture and test references for avoiding whole-session failure after interruption.
- [DeepSeek Harness MCP reconnect discussion](https://github.com/deepseek-ai/deepseek-harness/discussions/5105#discussioncomment-18206864): shared the Harness MCP Manager's stable tool wrappers, connection-error retry, exponential backoff, refreshed tool definitions, and the remaining design recommendation for slow retry after the fast reconnect budget is exhausted.
- [DeepSeek Harness expired-MCP-session discussion](https://github.com/deepseek-ai/deepseek-harness/discussions/3489#discussioncomment-18087110): documented the boundary between transport-level reconnect and application-level `-32001` session expiry, with a source-backed recovery runbook; this is a related upstream lifecycle case, not a claim that SandBase automatically handles every expired stateful MCP session.
- [DeepSeek Harness session export discussion](https://github.com/deepseek-ai/deepseek-harness/discussions/5108#discussioncomment-18206945): explained SandBase's stable session, paginated event, resumable stream, and artifact APIs as a format-independent audit/export surface, while clearly distinguishing them from DSH's internal zstd session-file format.
- [DeepSeek Harness observability discussion](https://github.com/deepseek-ai/deepseek-harness/discussions/5110#discussioncomment-18206986): shared the session usage fields, timestamped events, resumable event collector, Prometheus endpoint, and JSON metrics summary as a source-backed reference for log and token-usage export design.
- [DeepSeek Harness streaming-render discussion](https://github.com/deepseek-ai/deepseek-harness/discussions/5114#discussioncomment-18206989): clarified the server/UI boundary: transient token deltas do not advance durable replay cursors, while persisted events remain ordered and deduplicated; UI-side frame batching can reduce re-renders without weakening replay correctness.
- [DeepSeek Harness sandbox workdir discussion](https://github.com/deepseek-ai/deepseek-harness/discussions/5101#discussioncomment-18206994): shared source-backed workspace-root checks and negative tests for local, Kubernetes, artifact, and skill paths, while distinguishing early diagnostics from the OS/container isolation boundary.
- [DeepSeek Harness delegated-agent permissions discussion](https://github.com/deepseek-ai/deepseek-harness/discussions/5095#discussioncomment-18207004): shared SandBase's same-backend sandbox inheritance, explicit delegation roster/depth checks, child tool-surface rebuild, and the principle that inherited isolation must not imply inherited escalation.
- [DeepSeek Harness oversized-prompt discussion](https://github.com/deepseek-ai/deepseek-harness/discussions/5107#discussioncomment-18207013): shared SandBase's request-body, structured-event, SDK, and stable-session alternatives for large inputs, while explicitly agreeing that DSH still needs a native `--prompt-file`/stdin channel and argv preflight.
- [DeepSeek Harness torn-session-log discussion](https://github.com/deepseek-ai/deepseek-harness/discussions/5104#discussioncomment-18207016): clarified that SandBase uses an append-only SQLite event log with monotonic seq and orphan reconciliation rather than DSH's zstd format, then endorsed preserving confirmed complete records during tail repair.
- [dshbase](https://dshbase.com/plugins/sandbase-harness/): verified listing; the maintainer marked the plugin `test=verified` after headless L3 validation.
- [deepseek-plugin.org](https://deepseek-plugin.org/plugins/sandbaseai/sandbase-harness)
- [DeepseekPlugin](https://deepseekplugin.org/en/plugins/sandbaseai-sandbase-harness)
- [DSH Plugin Directory](https://dshplugin.app/plugins/sandbase-harness)
- [DSH Plugin Hub](https://dshpluginhub.dev/en/plugins/sandbaseai/sandbase-harness)
- [DSH Directory](https://dsh.directory/plugins/sandbaseai/sandbase-harness)
- [DSH Harness](https://dsharness.io/en/plugins?search=sandbase-harness)
- [FindHarness](https://findharness.com/plugins/sandbaseai-sandbase-harness)
- [DSH Plugin Directory](https://dsh-plugin.github.io/directory.html)
- [DSH Plugin Registry](https://github.com/dshplugin-app/deepseek-harness-plugins)
- [DSH Plugin](https://dshplugin.me/?q=sandbase-harness)
- [dshplugin.dev](https://dshplugin.dev/plugins/sandbaseai-sandbase-harness)
- [DSH Plugin](https://dsh-plugin.org/plugins/sandbaseai/sandbase-harness)
- [MCP Market](https://mcpmarket.com/server/sandbase-harness)
- [MCP Repository](https://mcprepository.com/sandbaseai/sandbase-harness)
- [MCPVault](https://mcpvault.io/servers/sandbase-harness): public automated listing verified; the page reports Apache-2.0 and current repository signals, but its own notice says the grade is computed from public signals and has not been maintainer-reviewed.
- [F8W 中文项目档案](https://www.f8w.com/github/sandbaseai__sandbase-harness/): public Chinese project profile verified with HTTP 200; its metadata matches the repository and current 638-star snapshot, but it is an independent index and not maintainer-reviewed.
- [SSD Nodes self-hosting guide](https://www.ssdnodes.com/learn/self-host-sandbase-agent-runtime): independent third-party walkthrough covering installation, MCP servers, sandbox modes, and reverse-proxy deployment; the article demonstrates v0.3.2, so current release instructions remain authoritative.
- [SandBase auditable research agent guide](https://blog.sandbase.ai/auditable-research-agent-evidence-ledger-sandbox-replay/): first-party practical guide showing evidence ledgers, sandboxed execution, credentials, audit, and replay.
- [OpenAgentSkill](https://www.openagentskill.com/skills/sandbaseai-sandbase-harness-code-review)
- [PluginBench](https://pluginbench.com/mcp/io.github.sandbaseai/sandbase-harness)
- [MCP Servers Live](https://linny006.github.io/mcp-servers-live/r/sandbaseai/sandbase-harness/)
- [DSH X-Ray](https://unstone.github.io/dsh-xray/p/sandbaseai__sandbase-harness.html)
- [Awesome DSH Plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
- [Awesome DeepSeek Harness](https://github.com/0xsline/awesome-deepseek-harness)
- [Awesome DeepSeek Harness — ecosystem list](https://github.com/fendouai/awesome-deepseek-harness)
- [DSHarness 101 Plugin Radar](https://dsharness101.com/plugins/)
- [DeepSeekDocs Ecosystem](https://deepseekdocs.com/en/ecosystem)
- [Awesome Agents](https://github.com/kyrolabs/awesome-agents)
- [Sifted Awesome AI Agents — verified Agent Runtime Top 100 entry](https://github.com/sifted-network/sifted-awesome-ai-agents/blob/main/top100/Agent%20Runtime.md): SandBase appears in the published Agent Runtime table; the generated snapshot currently shows it at rank 65 with 637 stars.
- [Arnon-hs Open Source / AtlasRepo — verified MCP entry](https://github.com/Arnon-hs/open-source/blob/main/mcp/sandbaseai-sandbase-harness.md): SandBase appears in the published MCP index at rank 72 with a generated project profile, score, metadata, and Chinese summary.
- [Sagargupta16 Awesome MCP Servers — merged entry](https://github.com/Sagargupta16/awesome-mcp-servers/pull/79): the merged developer-tools entry is present on the public README and describes SandBase as a self-hosted MCP runtime with sessions, sandboxing, permissions, and audit/replay.
- [Arnon-hs Open Source — MCP projects](https://github.com/Arnon-hs/open-source/blob/main/mcp/README.md)
- [SandBase Awesome Agent Runtime](https://github.com/sandbaseai/awesome-agent-runtime): public runtime landscape; its SandBase entry now links v0.3.8, the official MCP Registry, verified dshbase discovery, and the client installation guide via [merged PR #15](https://github.com/sandbaseai/awesome-agent-runtime/pull/15).
- [Awesome Agent Cortex](https://github.com/0xNyk/awesome-agent-cortex): SandBase CLI is publicly listed in the MCP ecosystem after [merged PR #72](https://github.com/0xNyk/awesome-agent-cortex/pull/72).
- [Awesome AI Devtools](https://github.com/yeaight7/awesome-ai-devtools): SandBase CLI is publicly listed in the MCP tooling comparison and catalog after [merged PR #33](https://github.com/yeaight7/awesome-ai-devtools/pull/33).
- [VoltAgent Awesome Agent Skills](https://github.com/VoltAgent/awesome-agent-skills): the SandBase `multi-source-search` skill is publicly listed after [merged PR #946](https://github.com/VoltAgent/awesome-agent-skills/pull/946).
- [WalkingLabs Awesome Harness Engineering](https://github.com/walkinglabs/awesome-harness-engineering): SandBase Harness is publicly listed in the Runtimes, Harnesses & Reference Implementations section after [merged PR #76](https://github.com/walkinglabs/awesome-harness-engineering/pull/76).
- [abordage/awesome-mcp](https://github.com/abordage/awesome-mcp)
- [cccakeee/awesome-dsh-plugins](https://github.com/cccakeee/awesome-dsh-plugins)
- [anbeime/skill — Skills index](https://github.com/anbeime/skill)
- [Awesome DeepSeek Harness Plugins](https://github.com/Zhiyuan-Fan/Awesome-DeepSeek-Harness-Plugins)
- [Hermes Ecosystem — SandBase stack](https://github.com/ksimback/hermes-ecosystem/blob/main/projects/sandbaseai/cli.html)
- [AgentStack](https://www.agentstack.live/mcp/io.github.sandbaseai/sandbase-harness)
- [HackSing DSH Plugins](https://github.com/HackSing/dsh-plugins)
- [Awesome DSH Plugins 2026](https://github.com/Herdeny/awesome-dsh-plugins-2026)
- [Glama](https://glama.ai/mcp/servers/sandbaseai/cli): SandBase has a public Glama page, but it is the CLI listing; no separate Harness listing was verified. The repository now declares maintainers in `glama.json` for a future authenticated claim.

## Pending or review-controlled

- [MCP.Directory submission](https://mcp.directory/submit): the submission API returned HTTP 409 with `This repository has already been submitted. We'll review it soon!`; no public listing URL is available yet.
- [mcpservers.org submission](https://mcpservers.org/submit): free submission accepted through the public form; the confirmation page states that SandBase Harness will be reviewed within 12 hours. The current public [SandBase page](https://mcpservers.org/servers/sandbaseai/cli) is for SandBase CLI and mentions Harness in the open-source stack, but no standalone Harness listing has been verified yet.
- [Open Source Observer OSS Directory PR #1211](https://github.com/opensource-observer/oss-directory/pull/1211): open; adds SandBase Harness to the actively maintained public OSS registry. `pnpm validate:projects` passed for all 7,133 projects, owner-validation is green, and the remaining CI is `ACTION_REQUIRED` pending fork-workflow approval; maintainer review is pending ([status note](https://github.com/opensource-observer/oss-directory/pull/1211#issuecomment-5468590097)).
- [OpenSourceChoice submission](https://opensourcechoice.com/): the public free-submission endpoint returned HTTP 202 and `{"ok":true}` after a pre-submit search found no SandBase match. The project is private until human review; no public listing is claimed yet.
- [Ossium submission](https://ossium.in/submit-oss): the public submission API returned HTTP 200 with `success:true` and review id `G1BPvgbobGfKn1x9nSasR`; free manual review is pending and no public project page is claimed yet.
- [MyMCPTools submission](https://mymcptools.com/submit): the directory advertises a free reviewed listing, but its submission route returned HTTP 403 to this environment and did not expose a usable form in Chrome; no submission is claimed and manual follow-up remains.
- [AgentDepot submission PR #9](https://github.com/biagruot/agentdepot-agents/pull/9): open; free MCP directory submission with a public-repository install path. The repository's `npm run validate` passed with 86 agents; current v0.3.8, Registry, and GHCR multi-arch evidence was added in [the follow-up comment](https://github.com/biagruot/agentdepot-agents/pull/9#issuecomment-5468810254); maintainer review is pending.
- [Mahonzhan Awesome Agent Harness issue #30](https://github.com/mahonzhan/awesome-agent-harness/issues/30): submitted a factual SandBase Harness entry for the Agent Harness / Agent Runtime section with v0.3.8, API, DeepSeek integration, and GHCR evidence; curator review is pending.
- [AutoJunjie Awesome Agent Harness issue #59](https://github.com/AutoJunjie/awesome-agent-harness/issues/59): submitted a factual SandBase Harness entry for the Agent Runtimes section with v0.3.8, API, DeepSeek integration, and GHCR evidence; curator review is pending.
- [to-real Awesome Agent Harness issue #7](https://github.com/to-real/awesome-agent-harness/issues/7): submitted a paired English/Chinese SandBase Harness entry for the runtime/execution section, with link-check-friendly repository, release, API, DeepSeek integration, and GHCR references; curator review is pending.
- [AgentMatter submission #2](https://www.agentmatter.net/submit): submitted the SandBase Harness MCP bridge from `Dockerfile.mcp` with DSH/Codex/Claude Code/Cursor/OpenCode compatibility metadata; the public API returned `accepted: true`, `previewOnly: false`, and the entry is in the review queue. A follow-up check found no public resource page yet (direct ID route 404; MCP catalog search still shows 13 existing resources without SandBase), so it remains pending.
- [AgentSpot submission #1](https://github.com/agentspot/agentspot-submissions/issues/1): submitted SandBase Harness to the free Agent category; the directory's published threshold is 100+ GitHub stars or 2,500 recent package downloads, and the repository currently meets the star threshold. Weekly curator review is pending.
- [dshbase submission #95](https://github.com/ylwl1997/dshbase/issues/95): closed after the maintainer confirmed the verified listing above.
- [Plugin Hub duplicate-install issue #78](https://github.com/sandbaseai/sandbase-harness/issues/78): open; added a non-destructive recovery path (update Hub, remove only the exact residual target, retry the fixed HTTPS Git source) and opened the upstream [Plugin Hub issue #25](https://github.com/dshplugin/dsh-plugin-hub/issues/25) for the idempotency fix. The current Hub v1.4.0 client appears to convert an installed catalog target to update semantics; upstream verification is pending ([project comment](https://github.com/sandbaseai/sandbase-harness/issues/78#issuecomment-5468727246), [upstream follow-up](https://github.com/dshplugin/dsh-plugin-hub/issues/25#issuecomment-5468733124)).
- [DeepSeek Awesome Agent PR #411](https://github.com/deepseek-ai/awesome-deepseek-agent/pull/411): open and clean; current v0.3.8, native DeepSeek Harness example, installation guide, and official Showcase context were posted for maintainer review.
- [Agent Switchboard listing PR #42](https://github.com/assafbar2/agentswitchboard.dev/pull/42): open; maintainer verification pending. The only reported check failure is the repository owner's Vercel authorization; current-version context was added in [the PR comment](https://github.com/assafbar2/agentswitchboard.dev/pull/42#issuecomment-5468257984).
- [OpenModels MCP Registry PR #20](https://github.com/openmodelsrun/mcp/pull/20): open and mergeable; maintainer review pending. The follow-up records the current v0.3.8 image, six-tool mapping, installation guide, and a fresh `python3 validate.py` pass across all 209 registry files ([comment](https://github.com/openmodelsrun/mcp/pull/20#issuecomment-5468897481)).
- [ForgeIndex submission](https://forgeindex.ai/): submitted through the directory's official Google Form with the repository, v0.3.8 release, MCP bridge, local/Docker runtime, and installation-guide links; the form returned “Your response has been recorded.” Publication and verification remain curator-controlled, so no public listing is claimed yet.
- [TensorBlock Awesome MCP Servers issue #2067](https://github.com/TensorBlock/awesome-mcp-servers/issues/2067) and [automated PR #2068](https://github.com/TensorBlock/awesome-mcp-servers/pull/2068): the active server-submission queue generated a separate SandBase Harness entry with the six-tool bridge metadata, stdio transport, Apache-2.0 license, and supported clients. A review comment flags the generated install command's missing image/env arguments before merge; this remains separate from the existing SandBase CLI entry.
- [Docker MCP Registry PR #4841](https://github.com/docker/mcp-registry/pull/4841): submitted SandBase Harness to Docker's official MCP Registry using the self-provided multi-architecture GHCR image. The registry entry passed its name/YAML/source/config validation, and the published image answered MCP `initialize` and `tools/list` with all six tools; Docker team review is pending.
- [ToolSDK MCP Registry PR #488](https://github.com/toolsdk-ai/toolsdk-mcp-registry/pull/488): submitted a Docker-backed SandBase Harness entry with the pinned v0.3.8 GHCR image, official installation guide, and URL/API-key configuration. `node scripts/validate-registry.mjs --base origin/main` passes with one changed package and zero errors; maintainer review is pending.
- [McpMux Server Registry PR #286](https://github.com/mcpmux/mcp-servers/pull/286): submitted a Docker-backed SandBase Harness definition with the pinned v0.3.8 GHCR image, runtime URL/API-key inputs, official documentation, and logo. The repository's per-file schema validation and 264-file conflict check both pass; maintainer review is pending.
- [add-mcp registry overlay PR #111](https://github.com/neon-solutions/add-mcp/pull/111): submitted the published OCI bridge to add-mcp's documented overlay path for package-only servers, with v0.3.8, stdio transport, GHCR image, and Harness URL/API-key metadata. The PR changes only `registry.overlay.json`; maintainer review is pending.
- [LobeHub Marketplace](https://github.com/lobehub/lobehub): checked the documented `@lobehub/market-cli` submission path; `plugin submit` currently requires an authenticated `lhm login`, and no LobeHub account/session is available in this environment. No submission is claimed.
- [curated_mcp_servers PR #9](https://github.com/oxbshw/curated_mcp_servers/pull/9): open; maintainer review pending.
- [Awesome MCP Servers PR #13201](https://github.com/punkpeye/awesome-mcp-servers/pull/13201): open; maintainer review pending. A follow-up records that the current [Glama SandBase page](https://glama.ai/mcp/servers/sandbaseai/cli) publicly mentions Harness, while noting that it is not a standalone Harness listing ([comment](https://github.com/punkpeye/awesome-mcp-servers/pull/13201#issuecomment-5468672754)).
- [WunderCorp Awesome MCP PR #54](https://github.com/wundercorp/awesome-mcp/pull/54): open; maintainer review pending.
- [Awesome AI Agents PR #57](https://github.com/aloth/awesome-ai-agents/pull/57): open; maintainer review pending.
- [Awesome Agent Infra PR #5](https://github.com/shenli/awesome-agent-infra/pull/5): open; maintainer review pending.
- [Awesome Agent Frameworks PR #7](https://github.com/alexbevi/awesome-agent-frameworks/pull/7): open; maintainer review pending.
- [Scottcjn Awesome Agents PR #59](https://github.com/Scottcjn/awesome-agents/pull/59): open; maintainer review pending.
- [Awesome Agentic MCP Security PR #28](https://github.com/mcp-security-project/awesome-agentic-mcp-security/pull/28): open; maintainer review pending.
- [Awesome Agent Harnesses PR #3](https://github.com/NeuraLiying/Awesome-Agent-Harnesses/pull/3): open; maintainer review pending.
- [Awesome Agent Runtime Security PR #28](https://github.com/bureado/awesome-agent-runtime-security/pull/28): open; maintainer review pending.
- [Awesome Agent Cortex PR #73](https://github.com/0xNyk/awesome-agent-cortex/pull/73): open; maintainer review pending.
- [Awesome Agentic Hardening PR #5](https://github.com/AgenticHardening/awesome-agentic-hardening/pull/5): open; maintainer review pending.
- [Awesome Agent Sandboxes PR #58](https://github.com/msyvr/awesome-agent-sandboxes/pull/58): open; maintainer review pending.
- [Arjan Awesome Agent Sandboxes PR #9](https://github.com/arjan/awesome-agent-sandboxes/pull/9): open; SandBase Harness added under self-hosted sandboxes; maintainer review pending.
- [Fishman Awesome Agent Sandbox PR #2](https://github.com/fishman/awesome-agent-sandbox/pull/2): open; SandBase Harness added to the sandbox list; maintainer review pending.
- [Dloss Awesome Agent Sandboxes PR #7](https://github.com/dloss/awesome-agent-sandboxes/pull/7): open and clean; SandBase Harness added to the sandbox list; maintainer review pending. Latest v0.3.8 context was posted in [the PR comment](https://github.com/dloss/awesome-agent-sandboxes/pull/7#issuecomment-5468252089).
- [Awesome AI Sandboxing PR #3](https://github.com/webcoyote/awesome-AI-sandbox/pull/3): open; maintainer review pending.
- [Awesome Agent Harness PR #86](https://github.com/Picrew/awesome-agent-harness/pull/86): open; maintainer review pending.
- [Awesome Security Agent Harnesses PR #1](https://github.com/Ed-Marcavage/awesome-security-agent-harnesses/pull/1): open; maintainer review pending; the target repository has pre-existing `awesome-lint` baseline errors documented in the PR.
- [Awesome Agent Infrastructure PR #21](https://github.com/backblaze-labs/awesome-agent-infrastructure/pull/21): open; focused SandBase entry under `execution-sandboxes`, with refreshed API/release/license evidence in [the follow-up comment](https://github.com/backblaze-labs/awesome-agent-infrastructure/pull/21#issuecomment-5468843018); duplicate PR #22 was closed to keep one review path.
- [Awesome Agent Control Plane PR #3](https://github.com/Ar9av/awesome-agent-control-plane/pull/3): open; existing focused entry under `Sandboxing & Isolation`, maintainer review pending.
- [Awesome AI Sandboxes PR #28](https://github.com/tizkovatereza/awesome-ai-sandboxes/pull/28): open; maintainer review pending.
- [Awesome CLI Coding Agents PR #313](https://github.com/bradAGI/awesome-cli-coding-agents/pull/313): open; SandBase Harness added under Agent infrastructure; maintainer review pending.
- [Awesome Loop Engineering resource suggestion #23](https://github.com/ChaoYue0307/awesome-loop-engineering/issues/23): submitted for review under Operations Playbooks; maintainer curation pending.
- [Awesome AI Engineering PR #4](https://github.com/Eric-LLMs/Awesome-AI-Engineering/pull/4): open; SandBase Harness added to the agent engineering project table; maintainer review pending.
- [Awesome AI Agents Frameworks PR #17](https://github.com/mb-mal/awesome-ai-agents-frameworks/pull/17): open; SandBase Harness added to the source repository list; maintainer review and generated ranking update pending.
- [Agent Infra Foundation PR #3](https://github.com/agent-infra-foundation/agent-infra-projects/pull/3): open; SandBase Harness added to the vendor-neutral agent infrastructure index; maintainer review pending.
- [MCPFind PR #168](https://github.com/MCPFind/mcp-find/pull/168): open; SandBase Harness added as an MCP server, maintainer review pending.
- [E2B Awesome AI SDKs PR #344](https://github.com/e2b-dev/awesome-ai-sdks/pull/344): open; maintainer review pending.
- [Agentic Community Landscape PR #2](https://github.com/agentic-community/agentic-landscape/pull/2): open; landscape entry review pending.
- [AIM Intelligence Awesome MCP Security PR #48](https://github.com/AIM-Intelligence/awesome-mcp-security/pull/48): open; maintainer review pending.
- [MCP Marketplace PR #5](https://github.com/aiagenta2z/mcp-marketplace/pull/5): open; maintainer review pending.
- [Awesome Agent Runtimes PR #1](https://github.com/dz3ai/awesome-agent-runtimes/pull/1): open; SandBase Harness runtime profile review pending.
- [Awesome AI Agent Runtimes PR #3](https://github.com/pandastack-io/awesome-ai-agent-runtimes/pull/3): open; SandBase Harness added to Self-Hosted Solutions and the comparison matrix; maintainer review pending.
- [Awesome Agent Harness PR #29](https://github.com/mahonzhan/awesome-agent-harness/pull/29): open; SandBase Harness added to the Agent Harness timeline; maintainer review pending.
- [Awesome Harness Engineering PR #224](https://github.com/ai-boost/awesome-harness-engineering/pull/224): open; SandBase Harness added to Demo Harnesses with local, Docker, Kubernetes, and worker execution details; maintainer review pending.
- [Awesome Agent Harnesses inclusion suggestion #1](https://github.com/open-kairox/awesome-agent-harnesses/issues/1): opened after the upstream fork name conflicted with an existing unrelated fork; maintainer can review the prepared entry and decide whether to include it.
- [Bilingual Awesome Agent Harness PR #6](https://github.com/to-real/awesome-agent-harness/pull/6): open; matching English and Chinese entries added to the reference harnesses section; maintainer review pending.
- [Bayshier Awesome Agent Harnesses PR #2](https://github.com/bayshier/awesome-agent-harnesses/pull/2): open; SandBase Harness added to Platforms & Frameworks with the submission-time star count and factual positioning; maintainer review pending.
- [Cline MCP Marketplace submission #2364](https://github.com/cline/mcp-marketplace/issues/2364): open; non-interactive Cline installation and stdio `initialize` handshake were documented for the published v0.3.8 bridge image; marketplace review pending.
- [ChatMCP MCPSo submission #3834](https://github.com/chatmcp/mcpso/issues/3834): open; submitted the official MCP metadata, v0.3.8 image, six-tool description, and self-hosted runtime configuration; review pending.
- [Harness Engineering Guide resource #70](https://github.com/nexu-io/harness-engineering-guide/issues/70): open; submitted SandBase Harness as a tool/framework reference for lifecycle, sandboxing, MCP, memory, credentials, audit, and replay; curator review pending.
- [BrethofAI Awesome MCP Servers proposal #12](https://github.com/BrethofAI/awesome-mcp-servers/issues/12): open; submitted the MCP bridge with official metadata, published image, and installation evidence; maintainer review pending.
- [Mctrinh Awesome MCP Servers PR #105](https://github.com/mctrinh/awesome-mcp-servers/pull/105): open; submitted the current SandBase Harness MCP bridge to the Production-Ready Servers list. This is a new, current-repository submission distinct from the closed PR #102 for the retired `sandbaseai/cli` repository; maintainer review pending.
- [Awesome Agent Frameworks architecture proposal #6](https://github.com/subinium/awesome-agent-frameworks/issues/6): open; submitted SandBase Harness with the requested concept, architecture, key trade-off, and selection guidance. The guide is explicitly opinionated and requires architectural analysis rather than a link-only addition; curator review pending.
- [Agent Sandbox Taxonomy profile proposal #5](https://github.com/kajogo777/the-agent-sandbox-taxonomy/issues/5): open; submitted a conservative, backend-aware profile proposal covering compute isolation, credentials, governance, and observability. The issue explicitly welcomes corrections and asks the maintainer to assign scores from repository evidence; taxonomy review pending.
- [Mossaka Awesome Agent Sandboxes PR #1](https://github.com/Mossaka/awesome-agent-sandboxes/pull/1): open; added SandBase Harness under Agent-Native Sandbox Platforms / Open Source with current stars, TypeScript, Apache-2.0, MCP, durable sessions, governance, and backend details; maintainer review pending.
- [Awesome Agent Observability PR #11](https://github.com/anhermon/awesome-agent-observability/pull/11): open; added SandBase Harness under Model Context Protocol as a self-hosted runtime for sessions, approvals, governed tool execution, and audit/replay records; the required repository-level lint currently fails only because the base repository lacks the `awesome` and `awesome-list` GitHub topics.
- [MCP Server Security Tools PR #5](https://github.com/ModelContextProtocol-Security/mcpserver-security-tools/pull/5): open; added SandBase Harness to the MCP security-tools catalog with a paired evaluation note, explicitly distinguishing governance/runtime controls from vulnerability scanning and documenting backend-dependent isolation.
- [Awesome MCP Security PR #12](https://github.com/tamish560/awesome-mcp-security/pull/12): open; added SandBase Harness to the Tools and code section as an open-source MCP governance/runtime tool, with a security-focused, non-marketing description covering approvals, credential scope, session isolation, and audit/replay.
- [Awesome Agent Tools PR #17](https://github.com/Awakehsh/awesome-agent-tools/pull/17): open; added SandBase Harness under Agent Runtimes with repository build/install guidance and factual coverage of persistent sessions, sandbox backends, MCP governance, and audit trails.
- [Yenanjing Awesome Harness Engineering PR #6](https://github.com/yenanjing/awesome-harness-engineering/pull/6): open; added SandBase Harness to the Agent Harness Frameworks table with the checked 638-star signal, Apache-2.0/TypeScript metadata, and runtime-specific capabilities; maintainer review pending.
- [Awesome Harness Engineering 中文版 PR #6](https://github.com/whobot-ai/awesome-harness-engineering-zh/pull/6): open; added a Chinese description under Harness 框架与工具 covering persistent sessions, MCP governance, approvals, audit/replay, and replaceable sandbox backends; maintainer review pending.
- [Awesome Agent Architecture issue #90](https://github.com/hardness1020/awesome-agent-architecture/issues/90): open; proposed SandBase as a source-backed system under study, mapped to tool runtime, permissions/sandbox, persistence, MCP, and observability sections; maintainer review pending.
- [ToolSDK MCP Registry PR #487](https://github.com/toolsdk-ai/toolsdk-mcp-registry/pull/487): open; SandBase Harness MCP bridge submission; registry review pending.
- [E2B Awesome MCP Gateways PR #77](https://github.com/e2b-dev/awesome-mcp-gateways/pull/77): open; SandBase Harness MCP bridge added to the gateway list; maintainer review pending.
- [AI Agent Infrastructure List PR #4](https://github.com/chgaowei/ai-agent-infra-list/pull/4): open; SandBase Harness added to runtime lists; maintainer review pending.
- [Awesome MCP Clients PR #182](https://github.com/AlexMili/Awesome-MCP/pull/182): open; SandBase Harness added as an MCP client/runtime integration; maintainer review pending.
- [Skyming Awesome AI Agent PR #19](https://github.com/skyming/awesome-ai-agent/pull/19): open; SandBase Harness added to open-source agent projects; maintainer review pending.
- [Awesome Multi-Agent AI Harnesses PR #4](https://github.com/ishandutta2007/Awesome-Multi-Agent-AI-Harnesses/pull/4): open; SandBase Harness added to Dedicated Multi-Agent Harness Systems with the project's existing stars-badge format; maintainer review pending.
- [Anandesh-Sharma Awesome Agent Harnesses PR #5](https://github.com/Anandesh-Sharma/awesome-agent-harnesses/pull/5): open; SandBase Harness added to Coding-Agent Harnesses with approximate stars and distinctive runtime design; maintainer review pending.
- [Awesome Agent Harness PR #58](https://github.com/AutoJunjie/awesome-agent-harness/pull/58): open; maintainer review pending.
- [Awesome AgentOps PR #14](https://github.com/natnew/awesome-agentops/pull/14): open; deployment/runtime infrastructure entry review pending.
- [Best of Agent Harnesses PR #99](https://github.com/RyanAlberts/best-of-Agent-Harnesses/pull/99): open; generated-list maintainer review pending.
- [Production Agentic Systems PR #57](https://github.com/EthicalML/awesome-production-agentic-systems/pull/57): open; maintainer review pending.
- [Awesome LLM Agents PR #318](https://github.com/kaushikb11/awesome-llm-agents/pull/318): open; maintainer review pending.
- [Docker MCP Registry PR #4838](https://github.com/docker/mcp-registry/pull/4838): open; registry review and validation pending.
- [Awesome AI Agents PR #467](https://github.com/jim-schwoebel/awesome_ai_agents/pull/467): open; maintainer review pending.
- [Authora Awesome Agent Security PR #10](https://github.com/authora-dev/awesome-agent-security/pull/10): open; maintainer review pending.
- [DevInsight Awesome MCP PR #6](https://github.com/devinsightdotio/awesome_mcp/pull/6): open; maintainer review pending.
- [RoyalPinto Awesome MCP Security PR #4](https://github.com/royalpinto007/awesome-mcp-security/pull/4): open; maintainer review pending.
- [Awesome AI Agents 2026 PR #539](https://github.com/caramaschiHG/awesome-ai-agents-2026/pull/539): open; maintainer review pending.
- [AdventureWave Awesome Agent Security PR #2](https://github.com/adventurewave-labs/awesome-agent-security/pull/2): open; maintainer review pending.
- [TensorBlock Awesome MCP Servers PR #2060](https://github.com/TensorBlock/awesome-mcp-servers/pull/2060): open; maintainer review pending.
- [Bureado Runtime Security PR #27](https://github.com/bureado/awesome-agent-runtime-security/pull/27): open; maintainer review pending.
- [Sagar Gupta Awesome MCP Servers PR #79](https://github.com/Sagargupta16/awesome-mcp-servers/pull/79): open; maintainer review pending.
- [Awesome MCP 中文 PR #521](https://github.com/yzfly/Awesome-MCP-ZH/pull/521): open; Chinese-language directory review pending.
- [Deep Insight Awesome AI Agents PR #50](https://github.com/Deep-Insight-Labs/awesome-ai-agents/pull/50): open; maintainer review pending.
- [Picrew Awesome Agent Harness PR #85](https://github.com/Picrew/awesome-agent-harness/pull/85): open and clean; current v0.3.8, runtime capabilities, and installation evidence were posted for maintainer review.
- [Awesome MCP List PR #408](https://github.com/MobinX/awesome-mcp-list/pull/408): open; maintainer review pending.
- [Awesome MCP Devtools PR #299](https://github.com/punkpeye/awesome-mcp-devtools/pull/299): open; maintainer review pending.
- [YuzeHao Awesome MCP Servers PR #461](https://github.com/YuzeHao2023/Awesome-MCP-Servers/pull/461): open; maintainer review pending.
- [Agentbrisk submission](https://agentbrisk.com/submit/): accepts open-source agents, frameworks, and MCP projects by email; no automated submission was attempted, so this remains a manual outreach candidate.
- [MeshKore directory submission](https://meshkore.com/submit): free public submission accepted with response `status=received`, submission id `13`, and a stated 24-hour review window; no public profile is claimed until the review creates one.
- [Promotion outreach templates](./promotion-outreach.md): ready-to-send factual drafts for Agentbrisk and harnesses.sh; no email or direct message was sent from this environment.
- [Agent Launchpad submission](https://launchpad.smartbizcalc.com/submit): free listing is available, but submission requires an authenticated magic-link session and a project screenshot; no credentials or upload were available, so this remains a manual outreach candidate.
- [harnesses.sh](https://www.harnesses.sh/about): curated, manually verified cross-vendor harness directory; SandBase is not currently indexed, and the site requests missing-harness corrections through the maintainer's public channels rather than a submission form, so this remains a manual outreach candidate.
- [MCP.so submission](https://mcp.so/submit): accepts MCP servers, agent apps, CLI tools, skills, and loops; SandBase is not currently indexed, but the submission endpoint requires an authenticated account, so this remains a manual outreach candidate.
- [A2M submission](https://a2m.one/submit): supports terminal-first AI project listings; SandBase is not currently indexed, but the submission flow requires account authentication through the A2M CLI/site, so this remains a manual outreach candidate.
- [AgentKart submission](https://www.agentkart.ai/submit): open-source AI agent marketplace with a public submission page, but the flow requires an authenticated site session; no credentials were available, so this remains a manual outreach candidate.
- [DeepYard submission](https://deepyard.dev/submit): submitted for review; no public listing confirmed.
- [MCP.Directory](https://mcp.directory/submit): the public submission API confirms the repository is already submitted and queued (`409`, “We'll review it soon!”); a public detail page is not yet discoverable. The free review queue is the selected path; no paid acceleration was used.
- [AIMCP submissions](https://www.aimcp.info/en/submit): pending; no public detail page confirmed.
- [AgentsAI.tools submission](https://agentsai.tools/submit): public agent form accepts GitHub projects without account login; the submission was attempted with the official repository details, but the backing Supabase hostname now returns NXDOMAIN in public DNS, so no successful submission is claimed and the form is gated until its backend is restored.
- [Moltbook AI submission](https://moltbook-ai.com/submit-tool): submitted the official repository, GitHub URL, factual runtime description, and project maintainer GitHub noreply contact through the public review form; HTTP 200 confirmation received, directory review pending.
- [AiAgents.Directory submission](https://aiagents.directory/submit/): submitted the official repository, factual runtime description, and project maintainer GitHub noreply contact through the public form; redirected to the site's success page, directory review pending.
- [CordisPlugin](https://cordisplugin.com/plugins/sandbaseai-sandbase-harness): a public detail-page result was discovered, but direct verification currently returns HTTP 402; do not treat its metadata or install instructions as verified until the page is accessible.
- [sandbase-blog freshness issue #272](https://github.com/sandbaseai/sandbase-blog/issues/272)
- [Handbook freshness issue #290](https://github.com/sandbaseai/deepseek-harness-handbook/issues/290)

## Gated or not eligible

- [AgentForge submission](https://agentforge.community/submit): the public form API returned `401 Authentication required`; no submission was created.
- [AgentAtlas submission](https://agentatlas.org/submit/): the directory advertises a one-time `$39` submission fee; no paid submission was made.
- [Bloom publish](https://www.usebloom.org/publish): open-source AI-agent registry with a public publish page, but publishing redirects to account sign-in; no account was available, so no submission was made.
- [agents-lib](https://agents-lib.com/): the public directory invites GitHub contributions, but its GitHub link currently points to the placeholder `your-org/agents-lib` repository; no unverifiable submission was made.
- [AI Agents Directory submission](https://aiagentautomation.site/submit/): the public form routes to a Dodo Payments checkout and the page advertises a $10 one-time listing fee; no paid submission was made.
- [CyberAgents Exchange](https://exchange.tenable.com/contributing): relevant free, vendor-neutral directory for open-source security agents, skills, MCP servers, and playbooks; manual submission requires accepting the CyberAgents Contribution Agreement and recording the acceptance timestamp, so no PR was opened without explicit authorization to accept that agreement.
- [AGNTCY Agent Directory Service](https://dir.agntcy.org/latest/): open OASF-based registry supporting MCP, A2A, and Agent Skills records; publishing requires an OASF record and a configured Directory node/network announcement, while SandBase currently has no A2A/OASF agent card, so this remains a future manifest/integration candidate rather than a claimed listing.
- [AAIF project proposal](https://aaif.io/submit-a-project): the Linux Foundation intake requires production adoption in at least two organizations, two maintainers from different organizations, at least ten contributors, and agreement to the hosted-project trademark/account and contribution-agreement process; the current project evidence does not satisfy those requirements, so no proposal was submitted.
- [AgentIndex missing-agent report #3](https://github.com/agentidx/agentindex/issues/3): submitted a structured request to index SandBase Harness as a local-first runtime with persistent sessions, sandboxed execution, MCP, approvals, audit, and replay; directory review pending.
- [Open Source Radar issue #7](https://github.com/sourav-ojha/open-source-radar/issues/7): the radar currently excludes SandBase Harness as marketing-driven because of the high number of directory links; a factual response documented independent SSD Nodes coverage, dshbase verification, F8W indexing, and the official Showcase for future reconsideration.
- [AI Agent Radar daily report #46](https://github.com/apiiskan/ai-agent-radar/issues/46): automatically included SandBase Harness in the 2026-08-30 report with MCP, Apache-2.0, examples, tests, and agent-runtime topic signals; this is a dated radar snapshot, not a maintainer-reviewed permanent listing.
- [Agent Infrastructure Landscape intake #173](https://github.com/MrPeppersDev/agent-infrastructure-landscape/issues/173): submitted a curator intake for the agent-infrastructure landscape; the issue was corrected to reflect the repository's Apache-2.0 license and review is pending.
- [AI Native Landscape project submission #18](https://github.com/rootsongjc/ai-native-landscape/issues/18): submitted bilingual project metadata under `platform-infra` / `sandboxes-runtimes`; curator review pending.
- [Agent Harness Token-Consumption Benchmark issue #1](https://github.com/ajensenwaud/agent-harness-benchmark/issues/1): proposed SandBase Harness as a headless runtime candidate, with the v0.3.8 release, installation guide, DeepSeek Harness example, and published MCP bridge image; benchmark maintainer review pending.
- [Agent Harness MCP preset proposal #47](https://github.com/madebywild/agent-harness/issues/47): proposed a source-backed SandBase Harness MCP preset or registry entity; integration maintainer review pending.
- [Awesome Agent Harness survey issue #14](https://github.com/Gloriaameng/Awesome-Agent-Harness/issues/14): proposed adding SandBase Harness to the Full-Stack Harnesses matrix with conservative E/T/C/S/L/V capability labels and source links; survey maintainer review pending.
- [RUCAIBox Agent Harness reading list issue #11](https://github.com/RUCAIBox/awesome-agent-harness/issues/11): proposed SandBase Harness as an open-source runtime resource with v0.3.8, MCP installation, Registry, and handbook evidence; research-list scope review pending.
- [DSH Plugin Market metadata PR #558](https://github.com/dsh-pluginmarket/metadata/pull/558): metadata entry is open, clean, and its `validate-submission` check is successful; current v0.3.8 and installation evidence were posted for maintainer review.
- [dshplugin.dev submission](https://dshplugin.dev/submit): public form requires Turnstile verification; no automated bypass attempted.
- [FindMCP](https://findmcp.app/submit): submission form is publicly reachable, but its API returned HTTP 500 for a valid open-source repository submission; no listing was created.
- [DSH Market](https://dshplugin.market/plugins/sandbase-harness): a public page exists, but its npm installation path is unsafe to promote: the public `managed-agents` package currently reports `latest` as `0.0.1`, while this repository is `0.3.8`; the page presents that package as the current runtime. The repository's GitHub-source install remains the source-of-truth path. Its submit page exposes placeholder correction links (`hello@example.com` and a non-existent issue route), and its API is disallowed by `robots.txt`, so no correction could be filed.
- [DSH Packs](https://www.dshpacks.com/plugins/sandbaseai-sandbase-harness/): public discovery is confirmed, but its install snippet still pins `v0.3.7`; use the repository's current release tag instead.
- [DSH Plugin Hub](https://dshpluginhub.dev/en/plugins/sandbaseai/sandbase-harness): public discovery is confirmed, but its indexed metadata still reports `0.3.7`; use the repository's current release tag and README as the source of truth.
- [deepseek-plugin.org](https://deepseek-plugin.org/plugins/sandbaseai/sandbase-harness): public discovery is confirmed, but the page still contains `v0.3.2` references; use the repository's current release tag and README as the source of truth.
- [DeepseekPlugin](https://deepseekplugin.org/en/plugins/sandbaseai-sandbase-harness): the public submission API confirms the repository is already listed, but its detail page still reports `v0.3.7`; use the repository's current release tag and README as the source of truth.
- [DSH Hub](https://dshhub.org/plugins/sandbaseai/sandbase-harness): a public detail page exists, but it currently presents the old `managed-agents` package/repository metadata; do not use it as the current installation source until corrected.
- [DSH Plugin](https://dsh-plugin.org/plugins/sandbaseai/sandbase-harness): public discovery is confirmed, but the detail page still reports `v0.3.7` and links to an older pinned commit; use the repository's current release tag and README as the source of truth. Its submission FAQ says listed projects sync automatically, so no duplicate submission is needed; recheck after the next directory refresh.
- [npm managed-agents](https://www.npmjs.com/package/managed-agents): unrelated package metadata points to [aiwhiteteam/open-managed-agents](https://github.com/aiwhiteteam/open-managed-agents), has a different maintainer, and reports `latest` as `0.0.1`; it is not a SandBase release and must not be promoted as an installation path.

## Promotion rules

- Verify the URL and page content before adding an entry.
- Keep pending submissions separate from public listings.
- Prefer useful setup guides, reproducible examples, and source-backed fixes.
- Never buy or manufacture stars, reviews, votes, or engagement.
- Do not claim official endorsement from a directory or upstream project.
