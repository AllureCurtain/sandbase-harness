import { describe, expect, it } from 'vitest';
import {
  isBlockedInternalHostname,
  isPrivateAddress,
  parseIpv6Bytes,
} from '@/core/web/address-policy.js';

/**
 * The mapping tests are the regression guard: a string-prefix check on
 * `::ffff:` plus dotted-quad text only recognized `::ffff:127.0.0.1`, and the
 * hex spellings of the same private address walked past the guard. Every
 * IPv4-mapped/compatible form must be parsed to its bytes and classified as
 * the IPv4 it embeds.
 */

describe('isPrivateAddress: IPv4-mapped IPv6', () => {
  const privateMapped: Array<[string, string]> = [
    ['::ffff:127.0.0.1', 'mapped dotted loopback'],
    ['::ffff:7f00:1', 'mapped hex loopback'],
    ['::ffff:a9fe:a9fe', 'mapped hex link-local (169.254.169.254)'],
    ['::ffff:169.254.169.254', 'mapped dotted link-local'],
    ['::ffff:0a00:0001', 'mapped hex RFC1918 (10.0.0.1)'],
    ['::ffff:c0a8:1', 'mapped hex RFC1918 (192.168.0.1)'],
    ['::ffff:ac10:1', 'mapped hex RFC1918 (172.16.1.0)'],
    ['0:0:0:0:0:ffff:7f00:1', 'fully expanded mapped loopback'],
    ['0000:0000:0000:0000:0000:ffff:7f00:0001', 'zero-padded expanded mapped loopback'],
    ['::7f00:1', 'deprecated IPv4-compatible loopback'],
    ['::a9fe:a9fe', 'deprecated IPv4-compatible link-local'],
    ['[::ffff:7f00:1]', 'bracketed mapped loopback'],
    ['::FFFF:7F00:1', 'uppercase mapped loopback'],
  ];

  for (const [address, label] of privateMapped) {
    it(`refuses ${label}`, () => {
      expect(isPrivateAddress(address)).toBe(true);
    });
  }

  const publicMapped: Array<[string, string]> = [
    ['::ffff:8.8.8.8', 'mapped dotted public'],
    ['::ffff:808:808', 'mapped hex public (8.8.8.8)'],
    ['::ffff:1.1.1.1', 'mapped dotted public resolver'],
  ];

  for (const [address, label] of publicMapped) {
    it(`allows ${label}`, () => {
      expect(isPrivateAddress(address)).toBe(false);
    });
  }
});

describe('isPrivateAddress: native IPv6 ranges', () => {
  it('refuses loopback, unspecified, unique-local, and link-local', () => {
    expect(isPrivateAddress('::1')).toBe(true);
    expect(isPrivateAddress('::')).toBe(true);
    expect(isPrivateAddress('fd12:3456::1')).toBe(true);
    expect(isPrivateAddress('fc00::')).toBe(true);
    expect(isPrivateAddress('fe80::1')).toBe(true);
    expect(isPrivateAddress('febf:ffff::1')).toBe(true);
  });

  it('allows public unicast ranges', () => {
    expect(isPrivateAddress('2001:4860:4860::8888')).toBe(false);
    expect(isPrivateAddress('2606:4700:4700::1111')).toBe(false);
    expect(isPrivateAddress('2001:db8:3:4::1')).toBe(false);
  });

  it('fails closed on strings that carry a colon but do not parse', () => {
    expect(isPrivateAddress(':::1')).toBe(true);
    expect(isPrivateAddress('12345:::')).toBe(true);
    expect(isPrivateAddress('gggg::1')).toBe(true);
  });
});

describe('isPrivateAddress: IPv4', () => {
  it('classifies octet ranges', () => {
    for (const address of ['0.0.0.0', '10.1.2.3', '127.0.0.1', '127.1', '169.254.1.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '100.64.0.1', '198.18.0.1']) {
      expect(isPrivateAddress(address), address).toBe(address !== '127.1');
    }
    for (const address of ['8.8.8.8', '1.1.1.1', '93.184.216.34']) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });
});

describe('parseIpv6Bytes', () => {
  const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

  it('expands compression on either side', () => {
    expect(hex(parseIpv6Bytes('::')!)).toBe('00'.repeat(16));
    expect(hex(parseIpv6Bytes('::1')!)).toBe(`${'00'.repeat(15)}01`);
    expect(hex(parseIpv6Bytes('1::')!)).toBe(`0001${'00'.repeat(14)}`);
    expect(hex(parseIpv6Bytes('2001:db8::1')!))
      .toBe('20010db8' + '00'.repeat(11) + '01');
    expect(hex(parseIpv6Bytes('1:2:3:4:5:6:7:8')!))
      .toBe('00010002000300040005000600070008');
  });

  it('folds embedded IPv4 tails into the same bytes as hex groups', () => {
    expect(hex(parseIpv6Bytes('::ffff:127.0.0.1')!))
      .toBe(hex(parseIpv6Bytes('::ffff:7f00:1')!));
    expect(hex(parseIpv6Bytes('::ffff:169.254.169.254')!))
      .toBe('00'.repeat(10) + 'ffffa9fea9fe');
  });

  it('rejects malformed addresses', () => {
    expect(parseIpv6Bytes(':::1')).toBeNull();
    expect(parseIpv6Bytes('1:2:3:4:5:6:7:8:9')).toBeNull();
    expect(parseIpv6Bytes('1:2:3:4:5:6:7')).toBeNull();
    expect(parseIpv6Bytes('gggg::1')).toBeNull();
    expect(parseIpv6Bytes('12345::')).toBeNull();
    expect(parseIpv6Bytes('::1.2.3.4.5')).toBeNull();
  });
});

describe('isBlockedInternalHostname', () => {
  it('refuses the internal name family case-insensitively', () => {
    expect(isBlockedInternalHostname('localhost')).toBe(true);
    expect(isBlockedInternalHostname('LOCALHOST')).toBe(true);
    expect(isBlockedInternalHostname('db.internal')).toBe(true);
    expect(isBlockedInternalHostname('print.lan.local')).toBe(true);
    expect(isBlockedInternalHostname('cache.localhost.')).toBe(true);
    expect(isBlockedInternalHostname('example.com')).toBe(false);
  });
});
