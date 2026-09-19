import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AddCredentialModal, ResourceModal } from '../../apps/console/src/components/modals/ResourceModals';

describe('Credential modal surfaces', () => {
  it('uses explicit create semantics for a new vault', () => {
    const html = renderToStaticMarkup(
      <ResourceModal kind="credential_vault" onClose={() => {}} onSaved={() => {}} />,
    );

    expect(html).toContain('Create a shared boundary for credentials used by your sessions.');
    expect(html).toContain('Create vault');
    expect(html).not.toContain('>Continue<');
    expect(html).toContain('>Cancel<');
    expect(html).toContain('Read credential vault guidance');
  });

  it('exposes credential choices and a curated-server search', () => {
    const html = renderToStaticMarkup(
      <AddCredentialModal vaultId="vlt_test" onClose={() => {}} onSaved={() => {}} />,
    );

    expect(html).toContain('Credential type');
    expect(html).toContain('MCP OAuth');
    expect(html).toContain('Bearer token');
    expect(html).toContain('Environment variable');
    expect(html).toContain('Filter curated MCP servers');
    expect(html).toContain('Custom MCP server URL');
  });
});
