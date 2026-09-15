const DEFAULT_STDERR_TAIL_BYTES = 64 * 1024;

/** Bounded, redacted diagnostics. stderr is never an event source. */
export class PiStderrTail {
  private buffer = Buffer.alloc(0);

  constructor(
    private readonly maxBytes = DEFAULT_STDERR_TAIL_BYTES,
    private readonly secrets: readonly string[] = [],
  ) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new RangeError('Pi stderr tail size must be a positive safe integer');
    }
  }

  append(chunk: Uint8Array | string): void {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk);
    this.buffer = Buffer.concat([this.buffer, bytes]);
    if (this.buffer.length > this.maxBytes) {
      this.buffer = this.buffer.subarray(this.buffer.length - this.maxBytes);
    }
  }

  text(): string {
    return redactPiDiagnostic(this.buffer.toString('utf8'), this.secrets);
  }
}

export function redactPiDiagnostic(value: string, secrets: readonly string[] = []): string {
  let result = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  for (const secret of secrets) {
    if (!secret || secret.length < 3) continue;
    result = result.replaceAll(secret, '[REDACTED]');
  }
  result = result.replace(
    /((?:authorization|api[_-]?key|token|secret|password)\s*[:=]\s*)([^\s,;]+)/gi,
    '$1[REDACTED]',
  );
  result = result.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]');
  return result.trim();
}
