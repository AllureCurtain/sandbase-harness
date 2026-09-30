import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { parse as parseYaml } from 'yaml';

const root = resolve(import.meta.dirname, '..');
const cli = join(root, 'dist', 'index.js');

if (!existsSync(cli)) {
  fail('dist/index.js is missing. Run `npm run build` before the release smoke test.');
}

await smokeInit();
await smokeExampleProject();
await smokePackagedMcpHandshake();

console.log('release smoke: ok');

async function smokeInit() {
  const workspace = await mkdtemp(join(tmpdir(), 'managed-agents-init-'));
  const result = spawnSync(process.execPath, [cli, 'init'], {
    cwd: workspace,
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    fail(`managed-agents init failed\n${result.stdout}\n${result.stderr}`);
  }

  for (const relativePath of [
    '.managed-agents/config.yaml',
    'agents/assistant.yaml',
    'skills/example-skill/SKILL.md',
  ]) {
    if (!existsSync(join(workspace, relativePath))) {
      fail(`managed-agents init did not create ${relativePath}`);
    }
  }
}

async function smokeExampleProject() {
  const exampleDir = join(root, 'examples', 'basic');
  // Read what the example asks for before starting it. A missing or emptied
  // configuration still starts, still loads the agent from `agents/`, and would
  // pass every check below while proving nothing: the runtime applies defaults
  // when the file is absent, so the file has to be checked for itself.
  const configPath = join(exampleDir, '.managed-agents', 'config.yaml');
  if (!existsSync(configPath)) {
    fail('examples/basic has no .managed-agents/config.yaml');
  }
  const declared = parseYaml(readFileSync(configPath, 'utf8'));
  const declaredVendor = declared?.model?.provider;
  if (typeof declaredVendor !== 'string' || declaredVendor.length === 0) {
    fail('examples/basic .managed-agents/config.yaml declares no model provider');
  }

  const dataDir = await mkdtemp(join(tmpdir(), 'managed-agents-example-data-'));
  const logFile = join(await mkdtemp(join(tmpdir(), 'managed-agents-example-logs-')), 'runtime.log');
  const port = await findFreePort();
  const child = spawn(process.execPath, [
    cli,
    'start',
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '--data-dir',
    dataDir,
    // Both state paths point outside the checkout: the smoke test must not leave
    // a database or a runtime log inside `examples/basic`, where the next
    // `npm pack` would pick them up.
    '--log-file',
    logFile,
    '--config',
    '.managed-agents/config.yaml',
    '--agents-dir',
    'agents',
    '--skills-dir',
    'skills',
  ], {
    cwd: join(root, 'examples', 'basic'),
    env: {
      ...process.env,
      OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? 'http://127.0.0.1:9/v1',
      OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? 'smoke-test-key',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    output += chunk.toString();
  });

  try {
    await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${port}/v1/x/health`);
      if (!response.ok) throw new Error(`health returned ${response.status}`);
      const agents = await fetch(`http://127.0.0.1:${port}/v1/agents`);
      if (!agents.ok) throw new Error(`agents returned ${agents.status}`);
      const body = await agents.json();
      if (!Array.isArray(body.data) || body.data.length < 1) {
        throw new Error('example project loaded no agents');
      }
      // The workspace is only the example's if its model came from the example's
      // file: a fresh workspace seeds its saved settings from `config.yaml`, so a
      // different vendor means the file was not read.
      const settings = await fetch(`http://127.0.0.1:${port}/v1/x/settings`);
      if (!settings.ok) throw new Error(`settings returned ${settings.status}`);
      const stored = (await settings.json()).saved_config?.model;
      if (stored?.vendor !== declaredVendor) {
        throw new Error(
          `examples/basic started with model vendor ${JSON.stringify(stored?.vendor)} instead of the `
          + `${JSON.stringify(declaredVendor)} its config.yaml declares`,
        );
      }
      // The version claim is checked against the packaged artifact, not only
      // against the source: `dist/index.js` sits at a different depth from the
      // repository root than `src/` does, which is what makes the manifest
      // lookup layout-dependent, and this is the copy a user installs. Retried
      // with everything else because the banner is written when the listener
      // opens and the health route above can answer first.
      await assertPackagedVersion(port, output);
    }, 10_000);
  } catch (error) {
    fail(`examples/basic smoke failed: ${error.message}\n${output}`);
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolveChild) => {
      const timeout = setTimeout(resolveChild, 1_000);
      child.once('exit', () => {
        clearTimeout(timeout);
        resolveChild();
      });
    });
  }
}

/**
 * The packaged runtime has to report the version it ships as.
 *
 * Both claims it makes about itself — the banner it prints and the `GET /` a
 * client reads — used to carry their own literal while the package was
 * something else, so a user's first line named a version this project never
 * shipped. This asserts the built copy, because that is the one that is
 * installed and the one whose manifest sits at a different depth.
 */
async function assertPackagedVersion(port, output) {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const expected = `managed-agents v${manifest.version}`;
  if (!output.includes(expected)) {
    throw new Error(`the packaged runtime has not printed ${JSON.stringify(expected)}`);
  }
  const response = await fetch(`http://127.0.0.1:${port}/`);
  if (!response.ok) throw new Error(`GET / returned ${response.status}`);
  const reported = (await response.json()).version;
  if (reported !== manifest.version) {
    throw new Error(
      `GET / reported version ${JSON.stringify(reported)} instead of ${JSON.stringify(manifest.version)}`,
    );
  }
}

/**
 * The packaged MCP server has to name itself the same way.
 *
 * `dist/mcp/index.js` is the second published entry point and the one a plugin
 * manifest starts, so `serverInfo` is a version claim a user reads without ever
 * touching this repository. It sits one directory deeper than the CLI entry,
 * which is the layout difference the reader exists to absorb.
 */
async function smokePackagedMcpHandshake() {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(root, 'dist', 'mcp', 'index.js')],
    // A handshake must not need a reachable runtime: the server connects to one
    // lazily, per tool call.
    env: { ...process.env, MANAGED_AGENTS_URL: 'http://127.0.0.1:9' },
  });
  const client = new Client({ name: 'release-smoke', version: '0.0.0' });

  try {
    await client.connect(transport);
    const reported = client.getServerVersion();
    if (reported?.name !== 'sandbase-harness' || reported.version !== manifest.version) {
      fail(
        `the packaged MCP server announced ${JSON.stringify(reported)} instead of `
        + `${JSON.stringify({ name: 'sandbase-harness', version: manifest.version })}`,
      );
    }
  } catch (error) {
    fail(`packaged MCP handshake failed: ${error.message}`);
  } finally {
    await client.close().catch(() => {});
  }
}

async function waitFor(fn, timeoutMs) {
  const start = Date.now();
  let lastError;
  while (Date.now() - start < timeoutMs) {
    try {
      await fn();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 200));
    }
  }
  throw lastError ?? new Error('timed out');
}

async function findFreePort() {
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : undefined;
  await new Promise((resolveClose) => server.close(resolveClose));
  if (!port) fail('could not allocate a free localhost port');
  return port;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
