import type { Context } from 'hono';
import type { UnsupportedCapabilityError } from '@/core/capabilities/registry.js';

/** Return the stable API envelope for rejected, non-executable capabilities. */
export function unsupportedCapability(c: Context, error: UnsupportedCapabilityError) {
  return c.json({
    error: {
      type: error.type,
      message: error.message,
      details: {
        capabilities: error.capabilities.map(({ id, reason }) => ({ id, reason })),
      },
    },
  }, 400);
}
