import { commandNamesPath, memoryBindingIsWritable, type MemoryBinding } from '@/core/memory/bindings.js';
import type { MemoryMountAdapter } from '@/core/memory/mount-adapter.js';

export interface SessionMemoryMount {
  adapter: MemoryMountAdapter;
  sessionId: string;
}

export function mountProviderUnavailable(mountPath: string): string {
  return `Error: ${mountPath} is a mounted memory store, but no memory store provider is available; refusing to fall through to the sandbox.`;
}

export function refuseBashOnMemoryMount(command: string, mounts: readonly MemoryBinding[]): string | undefined {
  if (mounts.length === 0) return undefined;
  const named = mounts.filter((mount) => commandNamesPath(command, mount.mountPath));
  const target = named.length > 0
    ? named.reduce((best, mount) => mount.mountPath.length > best.mountPath.length ? mount : best)
    : mounts[0];
  if (!memoryBindingIsWritable(target)) {
    return `Error: ${target.mountPath} is a read-only memory mount; shell access is refused for mounted memory paths.`;
  }
  return `Error: shell access is disabled while memory mounts are attached because command changes cannot be persisted back to memory_records. Use file tools under ${target.mountPath}.`;
}

export function mountRelativePath(path: string, binding: MemoryBinding): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  const mount = binding.mountPath.replace(/\/+$/, '');
  const remainder = normalized.slice(mount.length);
  return remainder.length === 0 ? '/' : (remainder.startsWith('/') ? remainder : `/${remainder}`);
}

export function editOnce(
  current: string,
  oldString: string,
  newString: string,
  path: string,
): { ok: true; value: string } | { ok: false; message: string } {
  const count = current.split(oldString).length - 1;
  if (count === 0) return { ok: false, message: `Error: old_string not found in ${path}` };
  if (count > 1) return { ok: false, message: `Error: old_string matches ${count} times in ${path}; provide a more specific string` };
  return { ok: true, value: current.replace(oldString, newString) };
}

export function collectGrepHits(hits: string[], display: string, content: string, query: string): void {
  content.split('\n').forEach((line, index) => {
    if (line.includes(query)) hits.push(`${display}:${index + 1}: ${line.trim()}`);
  });
}
