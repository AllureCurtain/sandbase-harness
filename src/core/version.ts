/**
 * The version this runtime reports about itself.
 *
 * There is one source for it: the `package.json` that ships beside the running
 * code. The reporting surfaces each carried their own literal (`0.1.0`) while
 * the package was `0.3.8`, so the first line a new user saw after `start` was
 * `managed-agents v0.1.0` and `GET /` answered the same string — a runtime that
 * names a version it is not.
 *
 * The manifest is found by walking up from this module instead of by a fixed
 * relative path, because the same code runs from three layouts: `src/core/`
 * under `tsx`, `dist/` in a build (the entry and the shared chunk it splits
 * into), and `node_modules/managed-agents/` in an install. A fixed path is
 * correct for exactly one of them, and the wrong ones fail quietly.
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** A manifest with another name is not this package's. */
const PACKAGE_NAME = 'managed-agents';

/** Reported when no manifest is reachable, e.g. a `dist/` copied without it. */
export const UNKNOWN_VERSION = '0.0.0-unknown';

/**
 * Read the version of the package that contains `from`.
 *
 * The walk stays in URL space deliberately. Under Node `import.meta.url` is a
 * string, while `tsx` and vitest hand over a `URL`, and a URL string that
 * reaches `node:path` is not a path: `dirname` and `join` turn
 * `file:///D:/app/dist/index.js` into `.\file:\D:\app\dist\package.json`, so
 * every read fails and the walk ends at the filesystem root — or, on a working
 * directory that happens to hold a manifest, at a version belonging to some
 * other checkout. `new URL` normalizes both shapes, and `../` steps up without
 * a separator convention to get wrong.
 *
 * @param from file URL of a module inside the package (a filesystem path is also accepted).
 */
export function readRuntimeVersion(from: string | URL = import.meta.url): string {
  let url = toFileUrl(from);
  for (;;) {
    try {
      const manifest = JSON.parse(readFileSync(new URL('package.json', url), 'utf8')) as {
        name?: unknown;
        version?: unknown;
      };
      if (manifest.name === PACKAGE_NAME && typeof manifest.version === 'string' && manifest.version !== '') {
        return manifest.version;
      }
    } catch {
      // Nothing readable here: keep walking rather than reporting a guess.
    }
    const parent = new URL('../', url);
    if (parent.href === url.href) return UNKNOWN_VERSION;
    url = parent;
  }
}

/** Accept a `URL`, a `file:` URL string, or a plain filesystem path. */
function toFileUrl(from: string | URL): URL {
  if (from instanceof URL) return from;
  return from.includes('://') ? new URL(from) : pathToFileURL(from);
}

/** The version this process reports, resolved once at import. */
export const RUNTIME_VERSION = readRuntimeVersion();