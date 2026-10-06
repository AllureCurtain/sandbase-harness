import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The legacy stylesheet is retired: app chrome lives in styles/shell.css and
// the shared kit it used to own lives in styles/sandbase.css.
const css = ['apps/console/src/styles/shell.css', 'apps/console/src/styles/sandbase.css']
  .map((file) => readFileSync(join(process.cwd(), file), 'utf8'))
  .join('\n');
const appCss = readFileSync(join(process.cwd(), 'apps/console/src/styles/app.css'), 'utf8');
// Session surfaces migrated onto the ported token system; their rules live
// in the page-local stylesheet, not the legacy stylesheet.
const sessionsCss = readFileSync(join(process.cwd(), 'apps/console/src/components/pages/sessions.css'), 'utf8');
// Resource surfaces (environments, credential vaults, memory stores) migrated
// onto the ported token system; their rules live in the page-local stylesheet.
const resourcesCss = readFileSync(join(process.cwd(), 'apps/console/src/components/pages/resources.css'), 'utf8');
// Operations surfaces (webhooks, scheduled deployments, outcomes) migrated the
// same way; their rules live in the page-local stylesheet.
const operationsCss = readFileSync(join(process.cwd(), 'apps/console/src/components/pages/operations.css'), 'utf8');
// Settings surfaces migrated too; their rules live in the page-local stylesheet.
const settingsCss = readFileSync(join(process.cwd(), 'apps/console/src/components/pages/settings/settings.css'), 'utf8');

function sessionRuleFor(selector: string): string {
  const match = sessionsCss.match(rulePattern(selector));
  expect(match, `Missing session CSS rule for ${selector}`).toBeTruthy();
  return match?.[2] ?? '';
}

function resourceRuleFor(selector: string): string {
  const match = resourcesCss.match(rulePattern(selector));
  expect(match, `Missing resource CSS rule for ${selector}`).toBeTruthy();
  return match?.[2] ?? '';
}

function operationsRuleFor(selector: string): string {
  const match = operationsCss.match(rulePattern(selector));
  expect(match, `Missing operations CSS rule for ${selector}`).toBeTruthy();
  return match?.[2] ?? '';
}

function settingsRuleFor(selector: string): string {
  const match = settingsCss.match(rulePattern(selector));
  expect(match, `Missing settings CSS rule for ${selector}`).toBeTruthy();
  return match?.[2] ?? '';
}

function settingsMediaRuleFor(condition: string, selector: string): string {
  return mediaRuleFor(condition, selector, settingsCss, 'settings');
}

describe('Console CSS contracts', () => {
  it('keeps Settings as a responsive two-pane layout that collapses on narrow screens', () => {
    expect(settingsRuleFor('.settingsShell')).toContain('grid-template-columns: 232px minmax(0, 1fr)');
    expect(settingsMediaRuleFor('max-width: 1080px', '.settingsShell')).toContain('grid-template-columns: 220px minmax(0, 1fr)');
    expect(settingsMediaRuleFor('max-width: 760px', '.settingsShell')).toContain('grid-template-columns: 1fr');
    expect(settingsMediaRuleFor('max-width: 760px', '.settingsNav')).toContain('flex-direction: row');
    expect(settingsMediaRuleFor('max-width: 760px', '.settingsNav')).toContain('overflow-x: auto');
  });

  it('keeps the runtime log viewer large enough for operations debugging', () => {
    expect(settingsRuleFor('.settingsLogsPage .runtimeLogPanel')).toContain('min-height: 520px');
    expect(settingsRuleFor('.runtimeLogList')).toContain('height: clamp(520px, calc(100vh - 390px), 820px)');
    expect(settingsRuleFor('.runtimeLogList')).toContain('min-height: 520px');
    expect(settingsRuleFor('.runtimeLogList')).toContain('overflow: auto');
  });

  it('keeps API reference and form grids responsive instead of forcing horizontal scroll', () => {
    const mobile = settingsMediaRuleFor('max-width: 760px', '.apiDocsShell');

    expect(settingsRuleFor('.apiDocsShell')).toContain('grid-template-columns');
    expect(mobile).toContain('grid-template-columns: 1fr');
    expect(settingsMediaRuleFor('max-width: 760px', '.apiParamRow')).toContain('grid-template-columns: 1fr');
  });

  it('keeps session conversations bounded while the transcript owns vertical scrolling', () => {
    expect(ruleFor('.shell')).toContain('height: 100%');
    expect(ruleFor('.mainSessionDetail')).toContain('overflow: hidden');
    expect(sessionRuleFor('.sessionDetail')).toContain('height: 100%');
    expect(sessionRuleFor('.conversationList')).toContain('overflow-y: auto');
    expect(sessionRuleFor('.sessionComposer')).toContain('border-top: 1px solid var(--line-soft)');
    expect(sessionRuleFor('.conversationJumpLatest')).toContain('position: absolute');
  });

  it('keeps tool cards transparent and gives the expanded details a readable light surface', () => {
    expect(sessionRuleFor('.conversationToolCard')).toContain('background: transparent');
    expect(sessionRuleFor('.conversationToolCard summary:hover')).toContain('box-shadow: 0 4px 12px');
    expect(sessionRuleFor('.conversationToolDetails')).toContain('border-left: 1px solid var(--line-soft)');
    expect(sessionRuleFor('.conversationToolResult')).toContain('font-family: var(--font-console)');
  });

  it('keeps resource registry choices compact and horizontally aligned', () => {
    // Field labels stack vertically; widget labels (pickers, toggles, inline
    // checkboxes) are excluded by the whitelist so their own layout rules win.
    const labelRule = ruleFor('label:is(.editField, .sessionField, .shortField, .compactField, .fieldRow)');
    expect(labelRule).toContain('flex-direction: column');
    expect(resourceRuleFor('.registryList button')).toContain('min-height: 66px');
    expect(resourceRuleFor('.registryList button.selected')).toContain('background: var(--accent-tint)');
  });

  it('retires the legacy stylesheet', () => {
    expect(existsSync(join(process.cwd(), 'apps/console/src/styles.css'))).toBe(false);
    expect(appCss).not.toContain('styles.css');
    expect(appCss).toContain('shell.css');
    expect(css).not.toMatch(/--surface-hover|--border-subtle|--text-soft|--muted\b|--radius\b(?!-)/);
  });

  it('keeps credential forms readable and protects secret fields', () => {
    expect(resourceRuleFor('.credentialTypeGrid')).toContain('grid-template-columns: repeat(3, minmax(0, 1fr))');
    expect(resourceRuleFor('.credentialTypeOption.selected')).toContain('background: var(--accent-tint)');
    expect(resourceRuleFor('.secretField input')).toContain('padding-right: 44px');
    expect(resourceRuleFor('.secretToggle')).toContain('height: 34px');
  });

  it('keeps operations expansion rows readable and hides operations tables on narrow screens', () => {
    expect(operationsRuleFor('.expansionRow td')).toContain('background: var(--inset)');
    expect(operationsRuleFor('.deliveriesTable th')).toContain('border-bottom: 1px solid var(--line-soft)');
    expect(operationsRuleFor('.webhookEventOptions')).toContain('display: grid');
    const mobile = operationsCss.match(/@media \(max-width: 760px\)\s*\{[\s\S]*?\.webhooks-table-frame[^{]*\{([^}]*)\}/);
    expect(mobile, 'Missing operations mobile table-hide rule').toBeTruthy();
    expect(mobile?.[1]).toContain('display: none');
    expect(css).not.toContain('.webhookEventPicker');
    expect(css).not.toContain('.deliveriesTable');
  });
});
function ruleFor(selector: string): string {
  const match = css.match(rulePattern(selector));
  expect(match, `Missing CSS rule for ${selector}`).toBeTruthy();
  return match?.[2] ?? '';
}

function mediaRuleFor(condition: string, selector: string, source: string = css, sourceName = 'CSS'): string {
  const mediaHeader = `@media (${condition})`;
  let mediaStart = source.indexOf(mediaHeader);
  let match: RegExpMatchArray | null = null;

  while (mediaStart >= 0) {
    const nextMedia = source.indexOf('@media ', mediaStart + mediaHeader.length);
    const block = source.slice(mediaStart, nextMedia === -1 ? undefined : nextMedia);
    match = block.match(rulePattern(selector));
    if (match) return match[2] ?? '';
    mediaStart = source.indexOf(mediaHeader, mediaStart + mediaHeader.length);
  }

  expect(match, `Missing ${sourceName} CSS rule for ${selector} inside @media (${condition})`).toBeTruthy();
  return '';
}

function rulePattern(selector: string): RegExp {
  return new RegExp(`(^|})[^{}]*${escapeRegExp(selector)}[^{}]*\\{([^}]*)\\}`, 'm');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
