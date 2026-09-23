/**
 * Pi's native tool vocabulary.
 *
 * A leaf module on purpose: the tool-policy compiler needs this list, and the
 * RPC wire will need it too, so it lives where neither has to pull in the
 * other's dependencies — no child process, no filesystem, no SDK. The names are
 * the ones Pi 0.84.4 ships as engine-native tools, which are *not* Harness
 * `ToolResolver` tools: the only way to make a declared policy true for them is
 * to express it in Pi's own vocabulary.
 */

export const PI_NATIVE_TOOLS = [
  'read',
  'write',
  'edit',
  'bash',
  'grep',
  'find',
  'ls',
  'powershell',
] as const;

export type PiNativeToolName = (typeof PI_NATIVE_TOOLS)[number];

export function isPiNativeTool(name: string): name is PiNativeToolName {
  return (PI_NATIVE_TOOLS as readonly string[]).includes(name);
}
