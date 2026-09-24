/**
 * Model resolution errors.
 *
 * These are the model-resolution codes only, not a general error taxonomy: they
 * name the configuration outcomes a caller has to be able to tell apart, plus
 * the authentication refusal a provider returns once a request has been made.
 * Every one of them used to surface as `internal_error`, which reads as a
 * runtime crash and points an operator at the wrong layer.
 *
 * The code travels on the error's `code` property, which `SessionManager`
 * already projects into `session.error.type` and classifies for
 * `retry_status` — so a code added here is visible to a client without a new
 * carrier.
 */

/** The requested model id is not available on the configured provider. */
export const MODEL_NOT_FOUND_CODE = 'model_not_found';

/** The reference names a provider that this workspace has not configured. */
export const MODEL_PROVIDER_NOT_CONFIGURED_CODE = 'model_provider_not_configured';

/** The provider configuration itself is unusable (no concrete model id). */
export const MODEL_CONFIG_INVALID_CODE = 'model_config_invalid';

/** The provider refused the request's credentials (HTTP 401/403). */
export const MODEL_AUTH_FAILED_CODE = 'model_auth_failed';

export type ModelErrorCode =
  | typeof MODEL_NOT_FOUND_CODE
  | typeof MODEL_PROVIDER_NOT_CONFIGURED_CODE
  | typeof MODEL_CONFIG_INVALID_CODE
  | typeof MODEL_AUTH_FAILED_CODE;

/**
 * Codes whose cause is a fixable configuration mistake rather than a broken
 * runtime. A turn that fails with one of these leaves the session resumable:
 * the operator corrects the provider or the agent's model and sends the next
 * event, instead of the runtime publishing `session.status_terminated` for a
 * mistake the caller can repair.
 */
export const RESUMABLE_MODEL_FAILURE_CODES: ReadonlySet<string> = new Set([
  MODEL_NOT_FOUND_CODE,
  MODEL_PROVIDER_NOT_CONFIGURED_CODE,
  MODEL_CONFIG_INVALID_CODE,
  MODEL_AUTH_FAILED_CODE,
]);

export class ModelResolutionError extends Error {
  constructor(
    public readonly code: ModelErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ModelResolutionError';
  }
}

/**
 * The shared message shape. Kept in one place so every resolution failure ends
 * with the same actionable list of what this workspace does have registered.
 */
function resolutionMessage(modelName: string, available: string[], detail?: string): string {
  const suggestion = available.length > 0
    ? `Available models: ${available.join(', ')}`
    : 'No models registered. Add a model provider in Dashboard Settings > Models';
  return `Model not found: "${modelName}". ${detail ? `${detail} ` : ''}${suggestion}`;
}

export class ModelNotFoundError extends ModelResolutionError {
  constructor(
    public readonly modelName: string,
    public readonly available: string[],
    detail?: string,
  ) {
    super(MODEL_NOT_FOUND_CODE, resolutionMessage(modelName, available, detail));
    this.name = 'ModelNotFoundError';
  }
}

export class ModelProviderNotConfiguredError extends ModelResolutionError {
  constructor(
    public readonly modelName: string,
    public readonly available: string[],
    detail: string,
  ) {
    super(MODEL_PROVIDER_NOT_CONFIGURED_CODE, resolutionMessage(modelName, available, detail));
    this.name = 'ModelProviderNotConfiguredError';
  }
}

export class ModelConfigInvalidError extends ModelResolutionError {
  constructor(
    public readonly modelName: string,
    public readonly available: string[],
    detail: string,
  ) {
    super(MODEL_CONFIG_INVALID_CODE, resolutionMessage(modelName, available, detail));
    this.name = 'ModelConfigInvalidError';
  }
}
