/**
 * Unit test: the mounted-route extractor ignores text that is not code.
 *
 * `route-table.ts` reads module source as **text**, which is what makes it able to
 * check the real mount graph without importing the server. The cost is that it has
 * to know which text is code, and it did not: a route mentioned in a comment or a
 * string literal counted as mounted.
 *
 * That is not a cosmetic bug. This extractor is what makes
 * `contracts/anthropic-cma/routes.md` and `API_REFERENCE_DOCS` describe exactly the
 * routes the server mounts, so a commented-out `app.route(...)` — nothing served —
 * left both guards green, while *deleting* the same line made them fail. The two
 * states differ by a `//`, and the guards were green in the one where the route
 * does not exist. The failure a guard cannot afford is the one that reports success.
 *
 * `parseModuleText` is exported for these cases: it is pure in the source text, so
 * the constructs can be exercised directly instead of by editing real modules.
 * The cases that matter most are the last two — masked text is only half the
 * requirement, since a stripper that also swallowed real registrations would be
 * worse than the bug.
 */

import { describe, it, expect } from 'vitest';
import { parseModuleText } from './support/route-table';

/** The registration being tested, in each syntactic position. */
const MOUNT = `app.route('/deployment_runs', deploymentRunsRoutes(deps, options));`;
const DIRECT = `app.post('/:id/archive', async (c) => archive(c));`;

function mountedIn(text: string): Array<{ prefix: string; factory: string }> {
  return parseModuleText(text).mounted;
}

function directIn(text: string): Array<{ method: string; path: string }> {
  return parseModuleText(text).direct;
}

describe('route-table extractor: code', () => {
  it('reads a real mount and a real registration', () => {
    expect(mountedIn(MOUNT)).toEqual([{ prefix: '/deployment_runs', factory: 'deploymentRunsRoutes' }]);
    expect(directIn(DIRECT)).toEqual([{ method: 'POST', path: '/:id/archive' }]);
  });

  it('reads a mount whose factory is imported under an alias', () => {
    const text = [
      `import { deploymentRunsRoutes as runs } from './deployment-runs.js';`,
      `app.route('/deployment_runs', runs(deps, options));`,
    ].join('\n');
    const parsed = parseModuleText(text);
    expect(parsed.imports).toContainEqual({ local: 'runs', specifier: './deployment-runs.js' });
    expect(parsed.mounted).toEqual([{ prefix: '/deployment_runs', factory: 'runs' }]);
  });

  it('records every name bound by one import statement', () => {
    // The extractor follows mounts through imports, so a name dropped here becomes
    // a mount it cannot resolve — and an unresolved mount silently contributes no
    // routes, which reads exactly like a module with no routes.
    const parsed = parseModuleText(`import { aRoutes, bRoutes as c } from './both.js';`);
    expect(parsed.imports).toEqual([
      { local: 'aRoutes', specifier: './both.js' },
      { local: 'c', specifier: './both.js' },
    ]);
  });

  it('reads registrations on every method it supports', () => {
    const text = [
      `app.get('/a', h);`,
      `app.post('/b', h);`,
      `app.put('/c', h);`,
      `app.patch('/d', h);`,
      `app.delete('/e', h);`,
    ].join('\n');
    expect(directIn(text).map((route) => route.method)).toEqual(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
  });

  it('reads a registration written inside a template literal that is itself code', () => {
    // A multi-line statement must not confuse the scanner, and a string argument
    // between the two registrations must not swallow the second one.
    const text = [
      `const title = \`Deployment \${name}\`;`,
      `app.get('/first', (c) => c.json({ title }));`,
      `app.get('/second', (c) => c.json({ message: 'not a route: app.get(\\'/fake\\', h)' }));`,
    ].join('\n');
    expect(directIn(text).map((route) => route.path)).toEqual(['/first', '/second']);
  });
});

describe('route-table extractor: comments', () => {
  it('ignores a line-commented mount', () => {
    // The reproduction from the Issue, verbatim.
    expect(mountedIn(`  // app.route('/deployment_runs', deploymentRunsRoutes(deps, options));`)).toEqual([]);
  });

  it('ignores a block-commented mount', () => {
    expect(mountedIn(`/* ${MOUNT} */`)).toEqual([]);
  });

  it('ignores a mount in a multi-line block comment', () => {
    const text = [
      '/*',
      ' * The deployment-runs collection used to be mounted here.',
      ` * ${MOUNT}`,
      ' */',
      `app.route('/v1/deployments', deploymentRoutes(deps));`,
    ].join('\n');
    expect(mountedIn(text)).toEqual([{ prefix: '/v1/deployments', factory: 'deploymentRoutes' }]);
  });

  it('ignores a commented-out registration', () => {
    expect(directIn(`// ${DIRECT}`)).toEqual([]);
    expect(directIn(`/* ${DIRECT} */`)).toEqual([]);
  });

  it('ignores a registration in a JSDoc block', () => {
    // Documentation that names the route it describes is the common case, and the
    // one most likely to look like a registration to a naive regex.
    const text = [
      '/**',
      ` * Archive a deployment. Registered as \`${DIRECT}\`.`,
      ' */',
      `app.post('/:id/pause', async (c) => pause(c));`,
    ].join('\n');
    expect(directIn(text).map((route) => route.path)).toEqual(['/:id/pause']);
  });

  it('does not treat a comment marker inside a string as a comment', () => {
    // Masking must not be fooled in the other direction: a URL in a string is not
    // a comment, and treating it as one would mask every registration after it.
    const text = [
      `const url = 'https://example.test//v1//not-a-comment';`,
      `app.get('/after', h);`,
    ].join('\n');
    expect(directIn(text).map((route) => route.path)).toEqual(['/after']);
  });

  it('does not treat a quote inside a comment as a string', () => {
    // An apostrophe in prose would otherwise open a string and mask the rest of
    // the file, hiding every later registration.
    const text = [
      `// The scheduler's own row, not the route's.`,
      `app.get('/after-comment', h);`,
    ].join('\n');
    expect(directIn(text).map((route) => route.path)).toEqual(['/after-comment']);
  });

  it('ends a line comment at the newline, not at end of file', () => {
    const text = [
      `// app.get('/commented-out', h);`,
      `app.get('/real', h);`,
    ].join('\n');
    expect(directIn(text).map((route) => route.path)).toEqual(['/real']);
  });
});

describe('route-table extractor: strings and templates', () => {
  it('ignores a mount inside a string literal', () => {
    expect(mountedIn(`const example = "${MOUNT}";`)).toEqual([]);
  });

  it('ignores a registration inside a single-quoted string', () => {
    expect(directIn(`const example = '${DIRECT}';`)).toEqual([]);
  });

  it('ignores a registration inside a template literal', () => {
    // A test or a message that prints the registration it is asserting about is
    // exactly where this appears.
    expect(directIn(`const expected = \`${DIRECT}\`;`)).toEqual([]);
  });

  it('ignores a registration interpolated into a template substitution', () => {
    // Masked deliberately: this extractor cannot see a computed path anyway, so
    // reporting the loss beats pretending the route is mounted.
    expect(directIn('const doc = `${' + DIRECT + '}`;')).toEqual([]);
  });

  it('ignores text after a quote without an apostrophe closing in', () => {
    // Escapes must not end the string early, or the rest of the file is scanned as
    // code and a quoted registration would count.
    const text = [
      `const s = 'it\\'s fine';`,
      `app.get('/after-escape', h);`,
    ].join('\n');
    expect(directIn(text).map((route) => route.path)).toEqual(['/after-escape']);
  });

  it('keeps a real registration after a string that contains a quote character', () => {
    const text = [
      `const s = "a \\"quoted\\" word";`,
      `app.get('/still-code', h);`,
    ].join('\n');
    expect(directIn(text).map((route) => route.path)).toEqual(['/still-code']);
  });
});

describe('route-table extractor: malformed input', () => {
  // An unterminated construct must not hang, and must not throw. Everything after
  // it is masked, so the module contributes nothing and the route guard reports its
  // routes as missing — a loud failure rather than a silent pass.
  it('handles an unterminated block comment', () => {
    expect(mountedIn(`/* ${MOUNT}`)).toEqual([]);
  });

  it('handles an unterminated string', () => {
    expect(directIn(`const s = 'unterminated;\n${DIRECT}`)).toEqual([]);
  });

  it('handles an unterminated template', () => {
    expect(directIn('const s = `unterminated;\n' + DIRECT)).toEqual([]);
  });

  it('handles empty input and a lone comment marker', () => {
    expect(parseModuleText('')).toEqual({ imports: [], direct: [], mounted: [] });
    expect(parseModuleText('//')).toEqual({ imports: [], direct: [], mounted: [] });
    expect(parseModuleText('/*')).toEqual({ imports: [], direct: [], mounted: [] });
  });

  it('reports nothing for a module that registers nothing', () => {
    expect(parseModuleText(`export const x = 1;`)).toEqual({ imports: [], direct: [], mounted: [] });
  });
});