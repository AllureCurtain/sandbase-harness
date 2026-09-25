/**
 * Mounted-route table.
 *
 * The Console API reference must document exactly the routes the server mounts.
 * That comparison used to run against a hand-written map inside the test itself,
 * which is how the whole `operations.ts` namespace — webhooks, scheduled
 * deployments and outcomes — stayed invisible to a check that reported green.
 *
 * This module expands the real mount graph from `src/api/server.ts`: it follows
 * composed routers, translates the `/v1/x` compatibility mirror back onto the
 * canonical `/v1` path when that canonical route is itself mounted, and reports
 * paths in the `{param}` form the reference data uses.
 *
 * The extraction is textual, which means it has to ignore text that is not code.
 * It did not, and a commented-out mount was counted as mounted: deleting a real
 * `app.route(...)` made these guards fail, while commenting it out — with nothing
 * served — left them green. A check that reports green over a real divergence is
 * worse than no check, because it transfers trust to a question nobody is asking
 * any more. `maskedPositions` is what closes that: a registration only counts when
 * it begins in code rather than inside a comment, a string, or a template literal.
 */

import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

const SERVER_FILE = resolve(process.cwd(), 'src', 'api', 'server.ts');

/** `app.get('/path', …)` and friends on a module's own router. */
const DIRECT_ROUTE = /app\.(get|post|put|delete|patch)\(\s*'([^']*)'/g;
/** `app.route('/prefix', composedRoutes(…))`. */
const MOUNTED_ROUTER = /app\.route\(\s*'([^']*)'\s*,\s*([A-Za-z0-9_]+)\s*\(/g;
/** `import { aRoutes, bRoutes as c } from './a.js'`. */
const NAMED_IMPORT = /import\s*\{([^}]+)\}\s*from\s*'([^']+)'/g;

export type MountedRoute = {
  method: string;
  /** `/v1/...` path with `{param}` placeholders. */
  path: string;
  /** Repository-relative module that registers it. */
  source: string;
};

type ModuleTable = {
  direct: Array<{ method: string; path: string }>;
  mounted: Array<{ prefix: string; factory: string }>;
  /** Factory name to the module that defines it. */
  imports: Map<string, string>;
};

/** Keys route sets the way the reference data writes them. */
export function routeKey(method: string, path: string): string {
  return `${method} ${path.replace(/\{[^}]+\}/g, '{}')}`;
}

export type ParsedModule = {
  direct: Array<{ method: string; path: string }>;
  mounted: Array<{ prefix: string; factory: string }>;
  /** Local factory name and the raw specifier it was imported from. */
  imports: Array<{ local: string; specifier: string }>;
};

/**
 * Extract a module's registrations from its source text.
 *
 * Pure in the text and separated from the filesystem so the extraction can be
 * tested against synthetic modules, including malformed ones that must not hang
 * or throw. `readModule` is the only caller that reads a file.
 */
export function parseModuleText(text: string): ParsedModule {
  const masked = maskedPositions(text);
  /**
   * Matches that begin in code rather than inside masked text.
   *
   * Only the start is tested. A registration's path argument is itself a string —
   * masked — so testing the whole match would reject every real route. What
   * identifies a commented-out or quoted registration is that `app.route(` begins
   * inside the comment or the string, not where the match ends.
   */
  const live = (regex: RegExp): RegExpMatchArray[] =>
    [...text.matchAll(regex)].filter((match) => !masked[match.index]);

  return {
    // One import statement may bind several factories — `import { aRoutes, bRoutes
    // as c } from './a.js'` — and each is a candidate mount target, so each clause
    // becomes its own entry rather than only the first.
    imports: live(NAMED_IMPORT).flatMap((match) =>
      match[1]
        .split(',')
        .map((clause) => ({
          local: clause.trim().split(/\s+as\s+/).pop()?.trim() ?? '',
          specifier: match[2],
        }))
        .filter((entry) => entry.local.length > 0),
    ),
    direct: live(DIRECT_ROUTE).map((match) => ({
      method: match[1].toUpperCase(),
      path: match[2],
    })),
    mounted: live(MOUNTED_ROUTER).map((match) => ({
      prefix: match[1],
      factory: match[2],
    })),
  };
}

/**
 * Which character offsets lie inside a comment, a string, or a template literal.
 *
 * A code generator would be the thorough answer, but this runs inside a guard and
 * must stay dependency-free and fast; a scanner that handles the constructs these
 * sources actually use is enough, and it errs toward masking. Erring toward
 * masking is the safe direction: an unmasked registration in a comment is the bug
 * being fixed, whereas an over-masked one can only produce a *failure* for a route
 * that is really mounted, which is visible immediately and loudly. The reverse
 * mistake is silent, which is the whole reason this function exists.
 *
 * Regex literals are the known gap. Telling `const a = /re/` from `const a = x /
 * y` needs the parser this is not, so a regex body is scanned as code. That cannot
 * mask a real registration — a regex ends at its own `/`, so scanning inside it
 * cannot run past it into a comment — and no route is registered inside a regex.
 * The consequence is that a `//` inside a regex literal would start a comment the
 * scanner believes in; there is none in `src/api`, and the failure would be a
 * missing route, which this guard reports rather than hides.
 *
 * `${…}` inside a template is treated as template text, not as code, so a
 * registration interpolated into a template string is masked. That is deliberate
 * and it is the safe direction: this extractor already cannot see registrations
 * whose path is computed rather than literal, so a route built inside a
 * substitution would be invisible whichever way this branch went — masking it
 * reports the loss instead of pretending otherwise.
 *
 * Malformed input must not hang. An unterminated block comment, string, or
 * template simply runs to end of file: everything after it is masked, so the
 * module contributes no registrations and the guard reports the routes it expected
 * as missing.
 */
function maskedPositions(text: string): boolean[] {
  const masked = new Array<boolean>(text.length).fill(false);
  let state: 'code' | 'line' | 'block' | 'single' | 'double' | 'template' = 'code';
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (state === 'code') {
      if (char === '/' && next === '/') { state = 'line'; masked[i] = true; continue; }
      if (char === '/' && next === '*') { state = 'block'; masked[i] = true; continue; }
      if (char === "'") { state = 'single'; masked[i] = true; continue; }
      if (char === '"') { state = 'double'; masked[i] = true; continue; }
      if (char === '`') { state = 'template'; masked[i] = true; continue; }
      continue;
    }

    masked[i] = true;
    if (state === 'line') {
      if (char === '\n') state = 'code';
      continue;
    }
    if (state === 'block') {
      if (char === '*' && next === '/') { masked[i + 1] = true; i += 1; state = 'code'; }
      continue;
    }
    if (escaped) { escaped = false; continue; }
    if (char === '\\') { escaped = true; continue; }
    if ((state === 'single' && char === "'")
      || (state === 'double' && char === '"')
      || (state === 'template' && char === '`')) {
      state = 'code';
    }
  }
  return masked;
}

export function mountedRoutes(): MountedRoute[] {
  const found: MountedRoute[] = [];
  expand(SERVER_FILE, '', [], found);

  const canonical = new Set(found.map((route) => `${route.method} ${route.path}`));
  const api = found.filter((route) => route.path === '/v1' || route.path.startsWith('/v1/'));

  return api
    .filter((route) => {
      // `/v1/x` is a compatibility mirror of the canonical `/v1` mount. Keep the
      // mirror only for a route that has no canonical twin.
      if (!route.path.startsWith('/v1/x')) return true;
      const mirrored = `/v1${route.path.slice('/v1/x'.length)}`;
      return !canonical.has(`${route.method} ${mirrored}`);
    })
    .sort((a, b) => routeKey(a.method, a.path).localeCompare(routeKey(b.method, b.path)));
}

/** The mounted set, keyed the way the reference data is keyed. */
export function mountedRouteKeys(): Set<string> {
  return new Set(mountedRoutes().map((route) => routeKey(route.method, route.path)));
}

function expand(file: string, prefix: string, chain: string[], out: MountedRoute[]): void {
  const table = readModule(file);
  const source = relative(process.cwd(), file).split('\\').join('/');

  for (const route of table.direct) {
    const path = normalizePath(joinPath(prefix, route.path));
    if (path) out.push({ method: route.method, path, source });
  }

  for (const mount of table.mounted) {
    const target = table.imports.get(mount.factory);
    // A module may be mounted more than once (the operations router is), so the
    // guard is the current chain rather than every file visited.
    if (!target || chain.includes(target)) continue;
    expand(target, joinPath(prefix, mount.prefix), [...chain, target], out);
  }
}

function readModule(file: string): ModuleTable {
  const parsed = parseModuleText(readFileSync(file, 'utf8'));
  const imports = new Map<string, string>();

  for (const entry of parsed.imports) {
    if (!entry.specifier.startsWith('.')) continue;
    imports.set(entry.local, resolveTypeScriptPath(dirname(file), entry.specifier));
  }

  return { imports, direct: parsed.direct, mounted: parsed.mounted };
}

/** Source imports are written for the emitted `.js`, so map back to the module. */
function resolveTypeScriptPath(fromDir: string, specifier: string): string {
  const resolved = resolve(fromDir, specifier);
  return resolved.endsWith('.js') ? `${resolved.slice(0, -3)}.ts` : resolved;
}

function joinPath(prefix: string, path: string): string {
  const suffix = path === '/' ? '' : path;
  return `${prefix}${suffix}`;
}

/** `''` and `'/'` both mean the prefix itself, so they are dropped. */
function normalizePath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}
