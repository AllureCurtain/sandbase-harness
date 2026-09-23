/**
 * The one Pi capability profile.
 *
 * Pi was described in two places — the Settings adapter descriptor and prose in
 * `docs/pi-loop-engine.md` — and the two drifted: the guide still claimed a
 * print-mode child per turn after the transport became RPC. This module is the
 * single definition. Settings, the API reference, and the truthfulness test all
 * read it, so a change to what Pi can actually do is made once and cannot leave
 * one surface describing the previous behaviour.
 *
 * The two `false` fields are the part most easily lost in a summary, so they are
 * stated explicitly rather than inferred from `tool_policy` or
 * `path_confinement`:
 *
 * - `native_tools_are_harness_tools: false` — Pi's `read`/`write`/`bash` are
 *   Pi's own tools. They never pass through Harness `ToolResolver`, so Harness
 *   sandbox path checks, MCP tools, delegation tools, and web tools do not
 *   apply to them and must not be routed to them.
 * - `engine_security_sandbox: false` — Pi ships no sandbox. Real isolation for
 *   untrusted input still has to come from Docker, Kubernetes, a VM, or another
 *   external boundary. The local sandbox is not that boundary.
 */

import type { LoopEngineCapabilityProfile } from '@/strategy/loop-engine/adapter.js';

export const PI_CAPABILITY_PROFILE: LoopEngineCapabilityProfile = {
  tool_policy: 'native_tools_only',
  tool_approval: 'rpc_gate',
  path_confinement: 'external_boundary',
  streaming: true,
  resume: true,
  native_tools_are_harness_tools: false,
  engine_security_sandbox: false,
};

/** Adapter id used by the descriptor list and the Settings UI. */
export const PI_ADAPTER_ID = 'pi';

/**
 * Human-readable capability ids published alongside the profile.
 *
 * `rpc-jsonl` replaces the old `stdout-jsonl` entry because the transport
 * changed: the session now owns one `--mode rpc` child rather than a print-mode
 * process per turn. The old name is not kept, because a client that branched on
 * it was branching on a mode this runtime no longer runs.
 */
export const PI_ADAPTER_CAPABILITY_IDS = [
  'rpc-jsonl',
  'session-continuity',
  'native-pi-tools',
  'native-tool-gate',
] as const;

/**
 * Why Pi is still not a peer of `builtin`, stated as the current boundary.
 *
 * It must remain true after this change: Pi now holds one long-lived child per
 * session and gates an `always_ask` native tool through its own managed
 * extension, but its native tools are still not Harness `ToolResolver` tools, so
 * they never pass Harness permission policy, MCP tools, or sandbox path checks —
 * and Pi still provides no security sandbox.
 */
export const PI_LOOP_ENGINE_REASON =
  'Runs the Pi CLI as a session-owned RPC child against the host-local work directory; Pi native tools are not governed by Harness approval or sandbox path policy, and an always_ask native tool is gated by a SandBase-managed Pi extension before it executes.';

/**
 * Requirements a runtime must satisfy before the Pi adapter can execute.
 *
 * Kept next to the reason so the descriptor and its requirements cannot
 * disagree about what Pi needs.
 */
export const PI_ADAPTER_REQUIREMENTS = ['Pi CLI available on PATH', 'local sandbox provider'] as const;
