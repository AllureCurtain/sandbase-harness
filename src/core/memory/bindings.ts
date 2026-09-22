import { nanoid } from 'nanoid';
import { DEFAULT_MEMORY_ACCESS, defaultMemoryMountPath, type MemoryAccess } from './semantics.js';

export interface MemoryStoreResourceLike {
  type?: unknown;
  memory_store_id?: unknown;
  access?: unknown;
  mount_path?: unknown;
  instructions?: unknown;
}

export interface MemoryBinding {
  storeId: string;
  mountPath: string;
  access: MemoryAccess;
  instructions?: string;
}

export function normalizeMemoryAccess(value: unknown): MemoryAccess {
  return value === 'read_only' ? 'read_only' : DEFAULT_MEMORY_ACCESS;
}

export function resolveMemoryBindings(
  resources: readonly MemoryStoreResourceLike[] | undefined,
  storeNameForStore?: (storeId: string) => string | undefined,
): MemoryBinding[] {
  if (!resources) return [];
  const bindings: MemoryBinding[] = [];
  for (const resource of resources) {
    if (resource?.type !== 'memory_store') continue;
    const storeId = resource.memory_store_id;
    if (typeof storeId !== 'string' || storeId.length === 0) continue;
    const mountPath = typeof resource.mount_path === 'string' && resource.mount_path.startsWith('/')
      ? normalizeMountPath(resource.mount_path)
      : (storeNameForStore ? defaultMemoryMountPath(storeNameForStore(storeId) ?? storeId) : undefined);
    if (!mountPath) continue;
    bindings.push({
      storeId,
      mountPath,
      access: normalizeMemoryAccess(resource.access),
      ...(typeof resource.instructions === 'string' && resource.instructions.trim()
        ? { instructions: resource.instructions.trim() }
        : {}),
    });
  }
  return bindings;
}

export function selectMemoryBinding(
  bindings: readonly MemoryBinding[],
  storeId?: string,
): MemoryBinding | undefined {
  if (bindings.length === 0) return undefined;
  return storeId === undefined ? bindings[0] : bindings.find((binding) => binding.storeId === storeId);
}

export function memoryBindingIsWritable(binding: MemoryBinding | undefined): boolean {
  return binding !== undefined && binding.access !== 'read_only';
}

export function memoryBindingForPath(
  bindings: readonly MemoryBinding[],
  path: string,
): MemoryBinding | undefined {
  const normalized = path.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  let best: MemoryBinding | undefined;
  for (const binding of bindings) {
    if (!pathInMount(normalized, binding.mountPath)) continue;
    if (!best || binding.mountPath.length > best.mountPath.length) best = binding;
  }
  return best;
}

export function writeToPathIsBlocked(
  bindings: readonly MemoryBinding[],
  path: string,
): boolean {
  const binding = memoryBindingForPath(bindings, path);
  return binding !== undefined && !memoryBindingIsWritable(binding);
}

export function pathInMount(path: string, mountPath: string): boolean {
  const normalized = path.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  const mount = normalizeMountPath(mountPath);
  if (!mount) return false;
  return normalized === mount || normalized.startsWith(`${mount}/`);
}

export function commandNamesPath(command: string, mountPath: string): boolean {
  if (!command || !mountPath) return false;
  const haystack = command.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  const needle = mountPath.replace(/\\/g, '/').replace(/\/+$/, '');
  let start = haystack.indexOf(needle);
  while (start !== -1) {
    const before = haystack[start - 1];
    const after = haystack[start + needle.length];
    const beforeBoundary = start === 0 || /[\s"';&|(<>=]/.test(before);
    const afterBoundary = after === undefined || /[\s"';&|()<>/]/.test(after);
    if (beforeBoundary && afterBoundary) return true;
    start = haystack.indexOf(needle, start + 1);
  }
  return false;
}

export function memoryBindingFingerprint(bindings: readonly MemoryBinding[]): string {
  return bindings.map((binding) => `${binding.storeId}:${binding.mountPath}:${binding.access}`).sort().join('|');
}

function normalizeMountPath(path: string): string | undefined {
  const normalized = path.trim().replace(/\\/g, '/').replace(/\/+$/, '').replace(/\/+/g, '/');
  if (!normalized.startsWith('/') || normalized === '/') return undefined;
  if (normalized.includes('\0')) return undefined;
  if (normalized.split('/').some((segment) => segment === '.' || segment === '..')) return undefined;
  return normalized;
}

export function memoryRecordId(): string {
  return `mem_${nanoid(18)}`;
}
