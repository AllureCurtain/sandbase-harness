import { useEffect, useState } from 'react';
import { getCursorPage } from './api';
import type { Agent } from './types';

/**
 * Loads the stored versions of one agent (`GET /v1/agents/:id/versions`).
 *
 * Fetching is keyed on the agent id so the versions panel can defer the
 * request until it is actually opened by passing `null` while collapsed.
 * Each list entry carries the full definition snapshot for that version,
 * which is what the diff and restore-as-draft flows render against.
 */
export function useAgentVersions(agentId: string | null): {
  versions: Agent[];
  loading: boolean;
  error: string;
} {
  const [versions, setVersions] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!agentId) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    getCursorPage<Agent>(`/v1/agents/${encodeURIComponent(agentId)}/versions`)
      .then((page) => {
        if (!cancelled) setVersions(Array.isArray(page?.data) ? page.data : []);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  return { versions, loading, error };
}
