const PI_CONTROL_TOKEN_RE = /<\|[A-Za-z0-9_-]+>[A-Za-z0-9_-]*|<[A-Za-z0-9_-]+\|>/g;
const STRUCTURED_PREFIXES = ['call:', 'response:'] as const;

/** Remove Pi structured tool markup, including markup split across chunks. */
export class PiMarkupBuffer {
  private value = '';

  push(delta: string): string {
    this.value += delta;
    const [emit, pending] = drainPiSanitizedText(this.value);
    this.value = pending;
    return emit;
  }

  flush(): string {
    const value = this.value;
    this.value = '';
    const [emit, pending] = drainPiSanitizedText(value);
    return emit + stripControlTokens(pending);
  }
}

export function stripPiToolCallMarkup(value: string): string {
  return stripControlTokens(stripPiStructuredToolMarkup(value));
}

export function stripPiStructuredToolMarkup(value: string): string {
  let output = '';
  for (let index = 0; index < value.length;) {
    const [start, prefixLength] = nextMarkupPrefix(value, index);
    if (start < 0) {
      output += value.slice(index);
      break;
    }
    output += value.slice(index, start);
    const [end, complete] = scanMarkupEnd(value, start + prefixLength);
    if (!complete) {
      output += value.slice(start);
      break;
    }
    index = end;
  }
  return output;
}

function drainPiSanitizedText(value: string): [string, string] {
  let output = '';
  for (let index = 0; index < value.length;) {
    const [start, prefixLength] = nextMarkupPrefix(value, index);
    if (start < 0) {
      const safeLength = safePiTextEmitLength(value.slice(index));
      output += value.slice(index, index + safeLength);
      return [stripControlTokens(output), value.slice(index + safeLength)];
    }
    output += value.slice(index, start);
    const [end, complete] = scanMarkupEnd(value, start + prefixLength);
    if (!complete) return [stripControlTokens(output), value.slice(start)];
    index = end;
  }
  return [stripControlTokens(output), ''];
}

/** Exported for focused tests of the boundary hold-back behavior. */
export function safePiTextEmitLength(value: string): number {
  let hold = 0;
  for (const prefix of STRUCTURED_PREFIXES) {
    for (let length = 1; length < prefix.length && length <= value.length; length += 1) {
      if (value.endsWith(prefix.slice(0, length))) hold = Math.max(hold, length);
    }
  }
  const lastOpen = value.lastIndexOf('<');
  if (lastOpen >= 0 && looksLikeControlPrefix(value.slice(lastOpen))) {
    hold = Math.max(hold, value.length - lastOpen);
  }
  return value.length - hold;
}

function nextMarkupPrefix(value: string, from: number): [number, number] {
  let best = -1;
  let bestLength = 0;
  for (const prefix of STRUCTURED_PREFIXES) {
    const index = value.indexOf(prefix, from);
    if (index >= 0 && (best < 0 || index < best)) {
      best = index;
      bestLength = prefix.length;
    }
  }
  return [best, bestLength];
}

function scanMarkupEnd(value: string, start: number): [number, boolean] {
  let index = start;
  const nameStart = index;
  while (index < value.length && isToolNameByte(value.charCodeAt(index))) index += 1;
  if (index === nameStart || index >= value.length || value[index] !== '{') return [0, false];

  const quoteMarker = '<|"|>';
  let depth = 0;
  let inQuote = false;
  while (index < value.length) {
    if (value.startsWith(quoteMarker, index)) {
      inQuote = !inQuote;
      index += quoteMarker.length;
      continue;
    }
    if (!inQuote) {
      if (value[index] === '{') depth += 1;
      if (value[index] === '}') {
        depth -= 1;
        index += 1;
        if (depth === 0) {
          if (value.startsWith('<tool_call|>', index)) index += '<tool_call|>'.length;
          return [index, true];
        }
        continue;
      }
    }
    index += 1;
  }
  return [0, false];
}

function isToolNameByte(code: number): boolean {
  return (code >= 0x30 && code <= 0x39)
    || (code >= 0x41 && code <= 0x5a)
    || (code >= 0x61 && code <= 0x7a)
    || code === 0x5f || code === 0x2d;
}

function looksLikeControlPrefix(value: string): boolean {
  if (!value.startsWith('<') || value.length > 64) return false;
  for (const char of value.slice(1)) {
    if (!/[A-Za-z0-9_|>-]/.test(char)) return false;
  }
  return true;
}

function stripControlTokens(value: string): string {
  return value.replace(PI_CONTROL_TOKEN_RE, '');
}
