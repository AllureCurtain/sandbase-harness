import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = 'tests/fixtures/pi/v0.84.4';

describe('versioned Pi fixture manifest', () => {
  it('pins synthetic fixture hashes and records expected canonical events', () => {
    const manifest = JSON.parse(readFileSync(`${root}/manifest.json`, 'utf8')) as {
      pi_cli_version: string;
      source: { category: string; revision: string };
      fixtures: Record<string, { sha256: string; expected_canonical_events: string[] }>;
    };
    expect(manifest.pi_cli_version).toBe('0.84.4');
    expect(manifest.source.category).toBe('synthetic contract');
    expect(manifest.source.revision).toBe('v0.84.4');

    for (const [name, fixture] of Object.entries(manifest.fixtures)) {
      const bytes = readFileSync(`${root}/${name}`);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(fixture.sha256);
      expect(fixture.expected_canonical_events.length).toBeGreaterThan(0);
      expect(bytes.toString('utf8')).not.toMatch(/(?:sk-|ghp_|Bearer\s+[A-Za-z0-9._~+/=-]{8,})/i);
    }
  });
});
