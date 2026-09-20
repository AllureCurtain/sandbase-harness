const DEFAULT_MAX_LINE_BYTES = 16 * 1024 * 1024;

export const PI_JSONL_MAX_LINE_BYTES = DEFAULT_MAX_LINE_BYTES;

export class PiJsonlProtocolError extends Error {
  readonly code = 'pi_jsonl_protocol_error';

  constructor(message: string, readonly lineNumber?: number) {
    super(message);
    this.name = 'PiJsonlProtocolError';
  }
}

/**
 * Read LF-delimited Pi JSONL without Node's readline implementation.
 *
 * `readline` has platform-specific Unicode line-separator behavior and cannot
 * enforce the byte limit before buffering an unbounded event. Pi can split a
 * UTF-8 code point across chunks, so framing is done on bytes and decoding is
 * performed only after a complete LF-delimited line is available.
 */
export async function* readPiJsonl(
  stream: AsyncIterable<Uint8Array | string>,
  maxLineBytes = DEFAULT_MAX_LINE_BYTES,
): AsyncGenerator<string> {
  if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes <= 0) {
    throw new RangeError('Pi JSONL max line size must be a positive safe integer');
  }

  let buffer = Buffer.alloc(0);
  let lineNumber = 0;
  const decoder = new TextDecoder('utf-8', { fatal: true });

  for await (const chunk of stream) {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk);
    if (bytes.length > 0) buffer = Buffer.concat([buffer, bytes]);

    let newlineIndex = buffer.indexOf(0x0a);
    while (newlineIndex >= 0) {
      const lineBytes = buffer.subarray(0, newlineIndex);
      buffer = buffer.subarray(newlineIndex + 1);
      lineNumber += 1;
      if (lineBytes.length > maxLineBytes) {
        throw new PiJsonlProtocolError(`Pi JSONL line exceeds ${maxLineBytes} bytes`, lineNumber);
      }

      let line: string;
      try {
        line = decoder.decode(lineBytes);
      } catch {
        throw new PiJsonlProtocolError('Pi JSONL line is not valid UTF-8', lineNumber);
      }
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.length > 0) yield line;
      newlineIndex = buffer.indexOf(0x0a);
    }

    if (buffer.length > maxLineBytes) {
      throw new PiJsonlProtocolError(`Pi JSONL buffered line exceeds ${maxLineBytes} bytes`, lineNumber + 1);
    }
  }

  if (buffer.length === 0) return;
  lineNumber += 1;
  if (buffer.length > maxLineBytes) {
    throw new PiJsonlProtocolError(`Pi JSONL line exceeds ${maxLineBytes} bytes`, lineNumber);
  }
  let line: string;
  try {
    line = decoder.decode(buffer);
  } catch {
    throw new PiJsonlProtocolError('Pi JSONL line is not valid UTF-8', lineNumber);
  }
  if (line.endsWith('\r')) line = line.slice(0, -1);
  if (line.length > 0) yield line;
}
