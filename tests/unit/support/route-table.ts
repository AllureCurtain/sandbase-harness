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
  const text = readFileSync(file, 'utf8');
  const imports = new Map<string, string>();

  for (const match of text.matchAll(NAMED_IMPORT)) {
    if (!match[2].startsWith('.')) continue;
    const target = resolveTypeScriptPath(dirname(file), match[2]);
    for (const clause of match[1].split(',')) {
      const local = clause.trim().split(/\s+as\s+/).pop()?.trim();
      if (local) imports.set(local, target);
    }
  }

  return {
    imports,
    direct: [...text.matchAll(DIRECT_ROUTE)].map((match) => ({
      method: match[1].toUpperCase(),
      path: match[2],
    })),
    mounted: [...text.matchAll(MOUNTED_ROUTER)].map((match) => ({
      prefix: match[1],
      factory: match[2],
    })),
  };
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
