/**
 * Address-level network policy shared by every outbound call the runtime makes
 * on behalf of a model (WebFetch today, webhook private-target detection
 * today). Keeping the classification in one place is what stops two copies
 * drifting apart and one of them silently growing a gap.
 *
 * These are reachability rules, not an allowlist: they answer "is this address
 * inside a network the operator has not exposed to the public internet", which
 * is the SSRF question a self-hosted runtime has to ask before letting model
 * output pick a destination.
 *
 * IPv6 classification parses the address into its 16 bytes rather than
 * matching string prefixes. `::ffff:7f00:1` and `::ffff:127.0.0.1` are the
 * same address written two ways, and an allow-list of textual shapes would
 * agree with only one of them; every IPv4-mapped and IPv4-compatible form is
 * reduced to its embedded IPv4 address before the private-range rules run, so
 * the hex spellings cannot slip past the dotted-quad ones.
 */

import net from 'node:net';

/** True for loopback, RFC 1918, link-local, CGNAT, benchmarking, and the IPv6 equivalents. */
export function isPrivateAddress(address: string): boolean {
  if (address.includes(':')) return isPrivateIpv6(address);
  return isPrivateIpv4Literal(address);
}

function isPrivateIpv4Literal(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  // Carrier-grade NAT and the benchmarking range are not publicly routable
  // either, and the hosted rule is about reachability, not about RFC 1918.
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  return false;
}

/**
 * Classify an IPv6 address by its bytes.
 *
 * An address that carries `:` but does not parse is refused (fail closed):
 * the callers hand this either a validated literal or a resolver answer, and
 * a string that looks like IPv6 yet does not parse is exactly the shape an
 * evasion tries to wear.
 */
function isPrivateIpv6(address: string): boolean {
  const bytes = parseIpv6Bytes(address);
  if (!bytes) return true;

  // IPv4-mapped (::ffff:0:0/96), in either the dotted (`::ffff:127.0.0.1`)
  // or the hex (`::ffff:7f00:1`) spelling: classify the embedded IPv4.
  if (isZeroRun(bytes, 0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return isPrivateIpv4Literal(bytesToDottedIpv4(bytes, 12));
  }
  // Deprecated IPv4-compatible (::/96). `::` itself is the unspecified
  // address and is as local as it gets.
  if (isZeroRun(bytes, 0, 12)) {
    if (bytes[12] === 0 && bytes[13] === 0 && bytes[14] === 0 && bytes[15] === 0) return true;
    return isPrivateIpv4Literal(bytesToDottedIpv4(bytes, 12));
  }
  if (bytes[15] === 1 && isZeroRun(bytes, 0, 15)) return true; // ::1 loopback
  if ((bytes[0] & 0xfe) === 0xfc) return true; // fc00::/7 unique-local
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true; // fe80::/10 link-local
  return false;
}

function isZeroRun(bytes: Uint8Array, from: number, to: number): boolean {
  for (let i = from; i < to; i += 1) {
    if (bytes[i] !== 0) return false;
  }
  return true;
}

function bytesToDottedIpv4(bytes: Uint8Array, at: number): string {
  return `${bytes[at]}.${bytes[at + 1]}.${bytes[at + 2]}.${bytes[at + 3]}`;
}

/**
 * Expand any valid IPv6 text form to its 16 bytes.
 *
 * Handles `::` compression (at most one), optional bracket wrapping, zone
 * identifiers, embedded IPv4 tails (`::ffff:127.0.0.1`), and leading-zero
 * shortening of hextets. Returns `null` for anything that is not a valid
 * address; `net.isIP` is consulted first so a non-address never enters the
 * expansion math.
 */
export function parseIpv6Bytes(input: string): Uint8Array | null {
  let text = input.trim().toLowerCase();
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1);
  const zone = text.indexOf('%');
  if (zone >= 0) text = text.slice(0, zone);
  if (!text || net.isIP(text) !== 6) return null;

  // Fold an embedded IPv4 tail into two hextets before the group split, so
  // `::ffff:127.0.0.1` and `::ffff:7f00:1` become the same group sequence.
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    if (net.isIP(tail) !== 4) return null;
    const octets = tail.split('.').map(Number);
    const hi = (octets[0] << 8) | octets[1];
    const lo = (octets[2] << 8) | octets[3];
    text = `${text.slice(0, lastColon + 1)}${hi.toString(16)}:${lo.toString(16)}`;
  }

  const [head, right, hasSecondMarker] = splitOnce(text);
  if (hasSecondMarker) return null; // a second `::` is invalid
  const compressed = text.includes('::');
  const leftGroups = head ? head.split(':') : [];
  const rightGroups = right ? right.split(':') : [];
  const groups = [...leftGroups, ...rightGroups];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
  }
  if (compressed ? groups.length > 7 : groups.length !== 8) return null;

  const bytes = new Uint8Array(16);
  let cursor = 0;
  for (const group of leftGroups) {
    const value = parseInt(group, 16);
    bytes[cursor] = value >> 8;
    bytes[cursor + 1] = value & 0xff;
    cursor += 2;
  }
  // `::` expands to every group the two sides do not carry.
  cursor = (8 - rightGroups.length) * 2;
  for (const group of rightGroups) {
    const value = parseInt(group, 16);
    bytes[cursor] = value >> 8;
    bytes[cursor + 1] = value & 0xff;
    cursor += 2;
  }
  return bytes;
}

/** Split on the single `::`; returns [left, right, invalidSecondMarker]. */
function splitOnce(text: string): [string, string, boolean] {
  const first = text.indexOf('::');
  if (first < 0) return [text, '', false];
  const second = text.indexOf('::', first + 1);
  if (second >= 0) return ['', '', true];
  return [text.slice(0, first), text.slice(first + 2), false];
}

/**
 * Host names that name an internal service regardless of what they resolve to.
 *
 * A resolver can be pointed anywhere, so a name in this family is refused
 * before DNS is consulted: `intranet.local` reaching 127.0.0.1 and reaching a
 * metadata endpoint are both refusals, and checking the name keeps the rule
 * independent of the current resolver state.
 */
const BLOCKED_INTERNAL_SUFFIXES = ['.localhost', '.local', '.internal', '.localdomain', '.invalid'] as const;

export function isBlockedInternalHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'localhost') return true;
  return BLOCKED_INTERNAL_SUFFIXES.some((suffix) => host.endsWith(suffix));
}
