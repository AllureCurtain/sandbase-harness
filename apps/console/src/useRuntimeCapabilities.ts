import { useEffect, useState } from 'react';
import { getJson } from './api';

/**
 * One Console-wide consumer of `GET /v1/x/capabilities`.
 *
 * The runtime owns the truthful inventory of locally executable built-in
 * tools, including the reason a capability is unavailable on this machine.
 * Hard-coding capability status in the Console would silently drift from that
 * inventory — exactly the contract drift this endpoint exists to settle — so
 * every surface that names a built-in tool renders its status from here.
 *
 * The inventory is fetched once per page load and shared: it describes the
 * runtime process, not a resource that changes per agent or session, and
 * every page would otherwise issue an identical request.
 */

export type RuntimeCapabilityStatus = 'available' | 'unavailable';

export interface RuntimeCapability {
  id: string;
  kind: 'tool';
  status: RuntimeCapabilityStatus;
  /** Runtime-reported reason the capability is unavailable on this machine. */
  reason?: string;
}

interface CapabilityInventory {
  type: string;
  capabilities: RuntimeCapability[];
}

let cache: RuntimeCapability[] | null = null;
let inflight: Promise<RuntimeCapability[]> | null = null;

function loadInventory(): Promise<RuntimeCapability[]> {
  if (cache) return Promise.resolve(cache);
  inflight ??= getJson<CapabilityInventory>('/v1/x/capabilities')
    .then((inventory) => {
      cache = Array.isArray(inventory.capabilities) ? inventory.capabilities : [];
      return cache;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export function useRuntimeCapabilities(): {
  capabilities: RuntimeCapability[];
  /** True when the inventory could not be loaded; callers render no claims. */
  error: boolean;
} {
  const [capabilities, setCapabilities] = useState<RuntimeCapability[]>(cache ?? []);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (cache) return;
    let cancelled = false;
    loadInventory()
      .then((list) => {
        if (!cancelled) setCapabilities(list);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { capabilities, error };
}

/**
 * The capabilities an agent actually enables, in registry order.
 *
 * Kept next to the loader so the selection rule is testable without a DOM: a
 * row is only ever rendered for a tool the agent enables, and the registry
 * decides what that row says.
 */
export function selectEnabledCapabilities(
  capabilities: RuntimeCapability[],
  enabledNames: ReadonlySet<string>,
): RuntimeCapability[] {
  return capabilities.filter((capability) => enabledNames.has(capability.id));
}
