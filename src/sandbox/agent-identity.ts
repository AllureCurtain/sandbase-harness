/**
 * Environment marker consumed by integrations that attribute child-process
 * activity to the harness that launched it.
 *
 * Keep an explicitly supplied standard marker untouched: a command may be
 * running a nested agent, and that agent should be able to identify itself.
 */
const AGENT_IDENTITY = 'sandbase-harness';

export function withAgentIdentity(env?: Record<string, string>): Record<string, string> {
  if (env && (Object.prototype.hasOwnProperty.call(env, 'AI_AGENT')
    || Object.prototype.hasOwnProperty.call(env, 'AGENT'))) {
    return { ...env };
  }

  return { AI_AGENT: AGENT_IDENTITY, ...(env ?? {}) };
}
