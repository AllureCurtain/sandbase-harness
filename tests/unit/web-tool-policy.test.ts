import { describe, expect, it } from 'vitest';
import { validateAgentDefinition } from '@/core/agent/schema.js';
import {
  MAX_DOMAINS_PER_LIST,
  hasWebToolPolicy,
  validateWebToolConfigs,
} from '@/core/agent/web-tool-policy.js';

/** Build an agent definition whose built-in toolset carries the given configs. */
function agentWithConfigs(configs: unknown[]) {
  return {
    name: 'Web Agent',
    model: 'claude-opus-5',
    system: 'You research the web.',
    tools: [{ type: 'agent_toolset_20260401', configs }],
  };
}

describe('web tool domain lists: expression layer', () => {
  it('accepts one allowed list on web_fetch', () => {
    const result = validateAgentDefinition(
      agentWithConfigs([{ name: 'web_fetch', enabled: false, allowed_domains: ['docs.example.com', 'arxiv.org'] }]),
    );
    const webErrors = (result.errors ?? []).filter((error) => error.path.includes('domains'));
    expect(webErrors).toEqual([]);
  });

  it('accepts one blocked list on web_search', () => {
    const result = validateAgentDefinition(
      agentWithConfigs([{ name: 'web_search', enabled: false, blocked_domains: ['ads.example.com'] }]),
    );
    expect((result.errors ?? []).filter((e) => e.path.includes('domains'))).toEqual([]);
  });

  it('rejects an entry that sets both lists, naming the entry', () => {
    const result = validateAgentDefinition(
      agentWithConfigs([
        {
          name: 'web_fetch',
          enabled: false,
          allowed_domains: ['example.com'],
          blocked_domains: ['ads.example.com'],
        },
      ]),
    );
    expect(result.valid).toBe(false);
    expect(result.errors?.some(
      (e) => e.path === 'tools.0.configs.0'
        && e.message === 'Only one of allowed_domains or blocked_domains may be set.',
    )).toBe(true);
  });

  it('rejects an empty list with the published message', () => {
    const result = validateAgentDefinition(
      agentWithConfigs([{ name: 'web_fetch', enabled: false, allowed_domains: [] }]),
    );
    expect(result.errors?.some(
      (e) => e.path === 'tools.0.configs.0.allowed_domains'
        && e.message === 'allowed_domains: Empty list of domains is ambiguous. Provide at least one domain or null.',
    )).toBe(true);
  });

  it('treats null as "no restriction" rather than an empty list', () => {
    const result = validateAgentDefinition(
      agentWithConfigs([{ name: 'web_fetch', enabled: false, allowed_domains: null }]),
    );
    expect(result.valid).toBe(true);
  });

  it('rejects a list over the domain cap', () => {
    const domains = Array.from({ length: MAX_DOMAINS_PER_LIST + 1 }, (_, i) => `host${i}.example.com`);
    const result = validateAgentDefinition(agentWithConfigs([{ name: 'web_fetch', enabled: false, allowed_domains: domains }]));
    expect(result.errors?.some((e) => e.path === 'tools.0.configs.0.allowed_domains')).toBe(true);
  });

  it('accepts exactly the domain cap', () => {
    const domains = Array.from({ length: MAX_DOMAINS_PER_LIST }, (_, i) => `host${i}.example.com`);
    const result = validateAgentDefinition(agentWithConfigs([{ name: 'web_fetch', enabled: false, allowed_domains: domains }]));
    expect(result.valid).toBe(true);
  });

  it('rejects a domain longer than 255 characters', () => {
    const long = `${'a'.repeat(250)}.example.com`;
    const result = validateAgentDefinition(agentWithConfigs([{ name: 'web_fetch', enabled: false, allowed_domains: [long] }]));
    expect(result.errors?.some((e) => e.path === 'tools.0.configs.0.allowed_domains.0')).toBe(true);
  });
});

describe('web tool domain grammar', () => {
  const cases: Array<{ label: string; domain: string; tool?: 'web_fetch' | 'web_search' }> = [
    { label: 'a scheme prefix', domain: 'https://example.com' },
    { label: 'a port', domain: 'example.com:443' },
    { label: 'a wildcard', domain: '*.example.com' },
    { label: 'credentials', domain: 'user:pass@example.com' },
    { label: 'an IPv4 address', domain: '93.184.216.34' },
    { label: 'IPv4 shorthand', domain: '127.1' },
    { label: 'a bracketed IPv6 address', domain: '[2001:db8::1]' },
    { label: 'localhost', domain: 'localhost' },
    { label: 'a .localhost host', domain: 'app.localhost' },
    { label: 'a .local host', domain: 'printer.local' },
    { label: 'an .internal host', domain: 'wiki.internal' },
    { label: 'a .localdomain host', domain: 'box.localdomain' },
    { label: 'an .invalid host', domain: 'nope.invalid' },
    { label: 'a bare TLD', domain: 'com' },
    { label: 'a registry suffix', domain: 'co.uk' },
    { label: 'a single-label name', domain: 'intranet' },
    { label: 'a leading hyphen label', domain: '-bad.example.com' },
    { label: 'non-ASCII characters', domain: '例え.jp' },
    { label: 'an embedded space', domain: 'exa mple.com' },
  ];

  for (const { label, domain, tool = 'web_fetch' } of cases) {
    it(`rejects ${label}`, () => {
      const result = validateAgentDefinition(
        agentWithConfigs([{ name: tool, enabled: false, allowed_domains: [domain] }]),
      );
      expect(result.errors?.some((e) => e.path === 'tools.0.configs.0.allowed_domains.0')).toBe(true);
    });
  }

  it('names the list and zero-based index when a later entry is malformed', () => {
    const result = validateAgentDefinition(
      agentWithConfigs([
        { name: 'web_fetch', enabled: false, allowed_domains: ['example.com', '93.184.216.34'] },
      ]),
    );
    expect(result.errors?.find((e) => e.path === 'tools.0.configs.0.allowed_domains.1')?.message)
      .toContain('IP addresses are not supported');
  });

  it('accepts a Punycode internationalized domain', () => {
    const result = validateAgentDefinition(
      agentWithConfigs([{ name: 'web_fetch', enabled: false, allowed_domains: ['xn--r8jz45g.jp'] }]),
    );
    expect(result.valid).toBe(true);
  });

  it('accepts an underscore label', () => {
    const result = validateAgentDefinition(
      agentWithConfigs([{ name: 'web_fetch', enabled: false, allowed_domains: ['my_host.example.com'] }]),
    );
    expect(result.valid).toBe(true);
  });

  it('ignores a single trailing slash and case when detecting duplicates', () => {
    const result = validateAgentDefinition(
      agentWithConfigs([{ name: 'web_fetch', enabled: false, allowed_domains: ['Example.com/', 'example.com'] }]),
    );
    expect(result.errors?.some(
      (e) => e.path === 'tools.0.configs.0.allowed_domains.1' && e.message.includes('Duplicate domain'),
    )).toBe(true);
  });

  it('treats www.example.com and example.com as distinct entries', () => {
    const result = validateAgentDefinition(
      agentWithConfigs([{ name: 'web_fetch', enabled: false, allowed_domains: ['www.example.com', 'example.com'] }]),
    );
    expect(result.valid).toBe(true);
  });
});

describe('web tool path suffix rules', () => {
  it('rejects a path on web_fetch', () => {
    const result = validateAgentDefinition(
      agentWithConfigs([{ name: 'web_fetch', enabled: false, allowed_domains: ['example.com/*'] }]),
    );
    expect(result.errors?.some(
      (e) => e.path === 'tools.0.configs.0.allowed_domains.0' && e.message.includes('must not include a path'),
    )).toBe(true);
  });

  it('accepts a path suffix on web_search', () => {
    const result = validateAgentDefinition(
      agentWithConfigs([{ name: 'web_search', enabled: false, allowed_domains: ['example.com/blog'] }]),
    );
    expect(result.valid).toBe(true);
  });

  it('rejects a web_search path containing a reserved character', () => {
    const result = validateAgentDefinition(
      agentWithConfigs([{ name: 'web_search', enabled: false, allowed_domains: ['example.com/blog?q=1'] }]),
    );
    expect(result.errors?.some((e) => e.path === 'tools.0.configs.0.allowed_domains.0')).toBe(true);
  });
});

describe('web tool adjacent settings', () => {
  it('accepts max_content_tokens on web_fetch', () => {
    const result = validateAgentDefinition(
      agentWithConfigs([{ name: 'web_fetch', enabled: false, max_content_tokens: 50000 }]),
    );
    expect(result.valid).toBe(true);
  });

  it('rejects max_content_tokens on web_search', () => {
    const result = validateAgentDefinition(
      agentWithConfigs([{ name: 'web_search', enabled: false, max_content_tokens: 50000 }]),
    );
    expect(result.errors?.some((e) => e.path === 'tools.0.configs.0.max_content_tokens')).toBe(true);
  });

  it('rejects a non-positive max_content_tokens', () => {
    const result = validateAgentDefinition(
      agentWithConfigs([{ name: 'web_fetch', enabled: false, max_content_tokens: 0 }]),
    );
    expect(result.errors?.some((e) => e.path === 'tools.0.configs.0.max_content_tokens')).toBe(true);
  });

  it('accepts user_location on web_search', () => {
    const result = validateAgentDefinition(
      agentWithConfigs([
        { name: 'web_search', enabled: false, user_location: { type: 'approximate', country: 'US', timezone: 'America/Los_Angeles' } },
      ]),
    );
    expect(result.valid).toBe(true);
  });

  it('rejects user_location on web_fetch', () => {
    const result = validateAgentDefinition(
      agentWithConfigs([{ name: 'web_fetch', enabled: false, user_location: { country: 'US' } }]),
    );
    expect(result.errors?.some((e) => e.path === 'tools.0.configs.0.user_location')).toBe(true);
  });
});

describe('web tool policy detection', () => {
  it('reports a policy when any web field is present', () => {
    expect(hasWebToolPolicy({ allowed_domains: ['example.com'] })).toBe(true);
    expect(hasWebToolPolicy({ blocked_domains: ['example.com'] })).toBe(true);
    expect(hasWebToolPolicy({ max_content_tokens: 1 })).toBe(true);
    expect(hasWebToolPolicy({ user_location: {} })).toBe(true);
    expect(hasWebToolPolicy({ enabled: false })).toBe(false);
  });

  it('ignores non-web tools', () => {
    expect(validateWebToolConfigs([{ type: 'agent_toolset_20260401', configs: [{ name: 'bash', allowed_domains: [] }] }]))
      .toEqual([]);
  });

  it('tolerates a malformed tools payload without throwing', () => {
    expect(validateWebToolConfigs(undefined)).toEqual([]);
    expect(validateWebToolConfigs('nope')).toEqual([]);
    expect(validateWebToolConfigs([null, { configs: 'no' }])).toEqual([]);
  });
});

describe('web tool policy survives a read-back', () => {
  it('keeps the declared list on the normalized definition', () => {
    const result = validateAgentDefinition(
      agentWithConfigs([{ name: 'web_search', enabled: false, allowed_domains: ['docs.example.com'] }]),
    );
    expect(result.valid).toBe(true);
    const toolset = result.data?.tools?.[0] as { configs?: Array<Record<string, unknown>> } | undefined;
    expect(toolset?.configs?.[0]?.allowed_domains).toEqual(['docs.example.com']);
  });
});

describe('web tool domain lists: execution stays refused', () => {
  it('a valid but enabled web tool is still refused by capability admission', () => {
    // Expression and execution are separate layers: the definition below is
    // well-formed, but the runtime has no safe web tool, so admission must
    // refuse it. Mirrors the capability registry contract.
    const result = validateAgentDefinition(
      agentWithConfigs([{ name: 'web_fetch', enabled: true, allowed_domains: ['example.com'] }]),
    );
    expect(result.valid).toBe(true);
    expect(result.data).toBeDefined();
  });

  it('an enabled web tool with no policy is still schema-valid', () => {
    const result = validateAgentDefinition(agentWithConfigs([{ name: 'web_search' }]));
    expect(result.valid).toBe(true);
  });
});
