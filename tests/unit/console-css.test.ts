import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(process.cwd(), 'apps/console/src/styles.css'), 'utf8');
// Session surfaces migrated onto the ported token system; their rules live
// in the page-local stylesheet, not the legacy stylesheet.
const sessionsCss = readFileSync(join(process.cwd(), 'apps/console/src/components/pages/sessions.css'), 'utf8');

function sessionRuleFor(selector: string): string {
  const match = sessionsCss.match(rulePattern(selector));
  expect(match, `Missing session CSS rule for ${selector}`).toBeTruthy();
  return match?.[2] ?? '';
}

describe('Console CSS contracts', () => {
  it('keeps Settings as a responsive two-pane layout that collapses on narrow screens', () => {
    expect(ruleFor('.settingsShell')).toContain('grid-template-columns: 232px minmax(0, 1fr)');
    expect(mediaRuleFor('max-width: 1080px', '.settingsShell')).toContain('grid-template-columns: 220px minmax(0, 1fr)');
    expect(mediaRuleFor('max-width: 760px', '.settingsShell')).toContain('grid-template-columns: 1fr');
    expect(mediaRuleFor('max-width: 760px', '.settingsNav')).toContain('flex-direction: row');
    expect(mediaRuleFor('max-width: 760px', '.settingsNav')).toContain('overflow-x: auto');
  });

  it('keeps the runtime log viewer large enough for operations debugging', () => {
    expect(ruleFor('.settingsLogsPage .runtimeLogPanel')).toContain('min-height: 520px');
    expect(ruleFor('.runtimeLogList')).toContain('height: clamp(520px, calc(100vh - 390px), 820px)');
    expect(ruleFor('.runtimeLogList')).toContain('min-height: 520px');
    expect(ruleFor('.runtimeLogList')).toContain('overflow: auto');
  });

  it('keeps API reference and form grids responsive instead of forcing horizontal scroll', () => {
    const mobile = mediaRuleFor('max-width: 760px', '.apiDocsShell');

    expect(ruleFor('.apiDocsShell')).toContain('grid-template-columns');
    expect(mobile).toContain('grid-template-columns: 1fr');
    expect(mediaRuleFor('max-width: 760px', '.formGrid')).toContain('grid-template-columns: 1fr');
    expect(mediaRuleFor('max-width: 760px', '.apiParamRow')).toContain('grid-template-columns: 1fr');
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

  it('keeps credential vault choices compact and horizontally aligned', () => {
    expect(ruleFor('.pickerPopover')).toContain('max-width: 460px');
    const labelRule = ruleFor('label:not(.filterSelect):not(.searchBox):not(.pickerOption)');
    expect(labelRule).toContain('flex-direction: column');
    expect(labelRule).not.toContain('pickerOption');
    const vaultOptions = ruleFor('.vaultPickerOptions .vaultOption');
    expect(vaultOptions).toContain('display: flex');
    expect(vaultOptions).toContain('min-height: 44px');
    expect(ruleFor('.vaultPickerOptions .vaultOption > span:last-child')).toContain('white-space: nowrap');
  });

  it('keeps credential forms readable and protects secret fields', () => {
    expect(ruleFor('.credentialTypeGrid')).toContain('grid-template-columns: repeat(3, minmax(0, 1fr))');
    expect(ruleFor('.credentialTypeOption.selected')).toContain('background: var(--accent-soft)');
    expect(ruleFor('.secretField input')).toContain('padding-right: 44px');
    expect(ruleFor('.secretToggle')).toContain('height: 34px');
  });
});
function ruleFor(selector: string): string {
  const match = css.match(rulePattern(selector));
  expect(match, `Missing CSS rule for ${selector}`).toBeTruthy();
  return match?.[2] ?? '';
}

function mediaRuleFor(condition: string, selector: string): string {
  const mediaHeader = `@media (${condition})`;
  let mediaStart = css.indexOf(mediaHeader);
  let match: RegExpMatchArray | null = null;

  while (mediaStart >= 0) {
    const nextMedia = css.indexOf('@media ', mediaStart + mediaHeader.length);
    const block = css.slice(mediaStart, nextMedia === -1 ? undefined : nextMedia);
    match = block.match(rulePattern(selector));
    if (match) return match[2] ?? '';
    mediaStart = css.indexOf(mediaHeader, mediaStart + mediaHeader.length);
  }

  expect(match, `Missing CSS rule for ${selector} inside @media (${condition})`).toBeTruthy();
  return '';
}

function rulePattern(selector: string): RegExp {
  return new RegExp(`(^|})[^{}]*${escapeRegExp(selector)}[^{}]*\\{([^}]*)\\}`, 'm');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
