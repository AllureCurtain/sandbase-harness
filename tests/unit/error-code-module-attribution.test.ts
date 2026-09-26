/**
 * Which module emits each public error code is pinned (item 18, error taxonomy — the second half of the
 * inventory).
 *
 * `error-codes.json` pins *which* codes exist. This pins *where* they come from, because a code that moves
 * between modules, or quietly gains a second emitter, is a behaviour change that the code-only inventory
 * cannot see: a caller reading `errors.md` to learn what raises `pi_session_busy` would be sent to a module
 * that no longer raises it.
 *
 * **Model.** The scan is deliberately the same two shapes as `error-code-inventory.test.ts`
 * (`code: '<literal>'` and `_CODE = '<literal>'`), because two different models of the same surface would
 * disagree in ways that look like defects. A code built another way is invisible to both, and the sibling
 * test is the canonical statement of that limitation.
 *
 * The two fixtures are also asserted to describe the **same set of codes**, so neither can be regenerated
 * without the other being noticed.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const INVENTORY = join(process.cwd(), 'tests', 'fixtures', 'error-codes.json');
const MODULES = join(process.cwd(), 'tests', 'fixtures', 'error-code-modules.json');

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(path));
    else if (entry.name.endsWith('.ts')) found.push(path);
  }
  return found;
}

/** Code -> repository-relative modules that emit it, by the same two shapes the inventory test models. */
function scanModules(): Record<string, string[]> {
  const found: Record<string, Set<string>> = {};
  const root = process.cwd();
  for (const file of sourceFiles(join(root, 'src'))) {
    const relative = file.substring(root.length + 1).split('\\').join('/');
    const text = readFileSync(file, 'utf8');
    const codes = [
      ...[...text.matchAll(/code:\s*'([a-z_]+)'/g)].map((m) => m[1]),
      ...[...text.matchAll(/_CODE\s*=\s*'([a-z_]+)'/g)].map((m) => m[1]),
    ];
    for (const code of codes) {
      found[code] ??= new Set<string>();
      found[code].add(relative);
    }
  }
  const sorted: Record<string, string[]> = {};
  for (const code of Object.keys(found).sort()) sorted[code] = [...found[code]].sort();
  return sorted;
}

function pinnedModules(): Record<string, string[]> {
  return (JSON.parse(readFileSync(MODULES, 'utf8')) as { modules: Record<string, string[]> }).modules;
}

function pinnedInventory(): string[] {
  return (JSON.parse(readFileSync(INVENTORY, 'utf8')) as { codes: string[] }).codes;
}

describe('error-code module attribution', () => {
  it('matches the modules the source emits each code from, in both directions', () => {
    const pinned = pinnedModules();
    const scanned = scanModules();
    expect(scanned).toEqual(pinned);
  });

  it('keeps the two fixtures describing the same codes', () => {
    // Regenerating one fixture without the other would leave the taxonomy self-contradictory; the sort makes
    // the comparison independent of however either file happens to be ordered.
    expect(Object.keys(pinnedModules()).sort()).toEqual([...pinnedInventory()].sort());
  });

  it('names at least one module per code, with no duplicates', () => {
    for (const [code, modules] of Object.entries(pinnedModules())) {
      expect(modules.length, `${code} must name a module`).toBeGreaterThan(0);
      expect(new Set(modules).size, `${code} must not repeat a module`).toBe(modules.length);
    }
  });
});
