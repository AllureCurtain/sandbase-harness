/**
 * Environment Variable Resolver
 *
 * Replaces ${VAR_NAME} placeholders in configuration strings
 * with actual environment variable values.
 */

const ENV_VAR_PATTERN = /\$\{([^}]+)\}/g;

export class EnvVarNotFoundError extends Error {
  constructor(public readonly varName: string) {
    super(`Environment variable not found: ${varName}`);
    this.name = 'EnvVarNotFoundError';
  }
}

/**
 * Resolve ${VAR_NAME} patterns in a string.
 * @param value - String potentially containing ${VAR} placeholders
 * @param required - If true, throw when a variable is not found; if false, leave the placeholder as-is
 */
export function resolveEnvVars(value: string, required = true): string {
  return resolveEnvVarsFrom(value, process.env, required);
}

/** Resolve placeholders from an explicit host environment without mutating it. */
export function resolveEnvVarsFrom(
  value: string,
  environment: NodeJS.ProcessEnv,
  required = true,
): string {
  return value.replace(ENV_VAR_PATTERN, (match, varName: string) => {
    const envValue = environment[varName];
    if (envValue === undefined) {
      if (required) {
        throw new EnvVarNotFoundError(varName);
      }
      return match; // leave placeholder unchanged
    }
    return envValue;
  });
}

/** Return the host variable names referenced by a configuration string. */
export function referencedEnvVars(value?: string): string[] {
  if (!value) return [];
  return [...new Set([...value.matchAll(ENV_VAR_PATTERN)].map((match) => match[1]))];
}

/**
 * Recursively resolve environment variables in an object's string values.
 * Only resolves string values; arrays and nested objects are traversed recursively.
 */
export function resolveEnvVarsDeep<T>(obj: T, required = true): T {
  if (typeof obj === 'string') {
    return resolveEnvVars(obj, required) as unknown as T;
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => resolveEnvVarsDeep(item, required)) as unknown as T;
  }
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = resolveEnvVarsDeep(value, required);
    }
    return result as T;
  }
  return obj;
}
