import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { delimiter, dirname, extname, join, resolve, sep, win32 } from 'node:path';
import { referencedEnvVars, resolveEnvVarsFrom } from '@/core/config/env-resolver.js';
import type { ModelConfig } from '@/types/model.js';

const INHERITED_ENVIRONMENT_KEYS = [
  'HOME', 'LANG', 'LC_ALL', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'TMPDIR',
  'TMP', 'TEMP', 'USER', 'USERPROFILE', 'SystemRoot', 'ComSpec',
] as const;

type PiModelConfig = Pick<ModelConfig, 'provider' | 'model' | 'base_url' | 'api_key'>;
type ResolvedPiModel = Required<Pick<PiModelConfig, 'provider' | 'model' | 'api_key'>>
  & Pick<PiModelConfig, 'base_url'>;

export interface PiLaunchRequest {
  sessionId: string;
  workDir: string;
  prompt: string;
  /** Already-composed agent system prompt, including loaded skills. */
  systemPrompt: string;
  /** Concrete configuration selected for this agent turn. */
  model: PiModelConfig;
  /** Cancels the in-flight child only after it has exited and released its workdir. */
  abortSignal?: AbortSignal;
}

export type PiProcessTerminator = (
  child: ChildProcess,
  platform: NodeJS.Platform,
  force: boolean,
) => void | Promise<void>;

export type PiProcessGroupInspector = (pid: number) => boolean;

export interface PiLauncherOptions {
  dataDir: string;
  command?: string;
  /** Test-only command prefix used by a controlled executable before Pi arguments. */
  commandArgs?: string[];
  spawnImpl?: typeof spawn;
  platform?: NodeJS.Platform;
  /** Host Settings environment used for resolving model placeholders. */
  environment?: NodeJS.ProcessEnv;
  fileExists?: (path: string) => boolean;
  /** Test seam for terminating an in-flight Pi child process tree. */
  terminateProcess?: PiProcessTerminator;
  /** Bounded grace period before a POSIX process-group kill is escalated. */
  terminationGraceMs?: number;
  /** Test seam for determining whether a POSIX Pi process group is still alive. */
  processGroupAlive?: PiProcessGroupInspector;
}

export interface PiCliProbeOptions {
  command?: string;
  /** Test-only command prefix used by a controlled executable before probe arguments. */
  commandArgs?: string[];
  spawnImpl?: typeof spawn;
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  fileExists?: (path: string) => boolean;
}

export interface PiCliProbeResult {
  available: boolean;
  message: string;
}

export interface PiInvocationOptions {
  command?: string;
  commandArgs?: string[];
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  fileExists?: (path: string) => boolean;
}

/**
 * Resolves Pi's executable invocation without invoking a shell. npm's Windows
 * shim is a .cmd file, but direct .cmd spawning is fragile; run its adjacent
 * PowerShell script through a fixed -Command expression that forwards @args.
 */
export function piInvocationFor(
  piArgs: string[],
  options: PiInvocationOptions = {},
): { file: string; args: string[] } {
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const command = options.command ?? 'pi';
  const commandArgs = options.commandArgs ?? [];
  const fileExists = options.fileExists ?? existsSync;
  const executable = platform === 'win32'
    ? resolveWindowsCommand(command, environment, fileExists)
    : command;

  if (platform !== 'win32' || extname(executable).toLowerCase() !== '.cmd') {
    return { file: executable, args: [...commandArgs, ...piArgs] };
  }

  const ps1 = win32.join(win32.dirname(executable), `${win32.basename(executable, '.cmd')}.ps1`);
  if (!fileExists(ps1)) {
    throw new Error('Pi CLI PowerShell shim is missing next to its npm pi.cmd executable');
  }
  const systemRoot = environment.SystemRoot?.trim() || 'C:\\Windows';
  return {
    file: win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      '& $args[0] @args[1..($args.Length - 1)]', ps1, ...commandArgs, ...piArgs,
    ],
  };
}

/** Launches one print-mode Pi turn with a private per-session file and config. */
export class PiLauncher {
  private readonly command: string;
  private readonly commandArgs: string[];
  private readonly spawnImpl: typeof spawn;
  private readonly platform: NodeJS.Platform;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly fileExists: (path: string) => boolean;
  private readonly terminateProcess: PiProcessTerminator;
  private readonly terminationGraceMs: number;
  private readonly processGroupAlive: PiProcessGroupInspector;

  constructor(private readonly options: PiLauncherOptions) {
    this.command = options.command ?? 'pi';
    this.commandArgs = options.commandArgs ?? [];
    this.spawnImpl = options.spawnImpl ?? spawn;
    this.platform = options.platform ?? process.platform;
    this.environment = options.environment ?? process.env;
    this.fileExists = options.fileExists ?? existsSync;
    this.terminateProcess = options.terminateProcess ?? terminatePiProcess;
    this.terminationGraceMs = options.terminationGraceMs ?? 1_000;
    this.processGroupAlive = options.processGroupAlive ?? isProcessGroupAlive;
  }

  async launch(request: PiLaunchRequest): Promise<void> {
    // Resolve against the host Settings environment before materializing either
    // the per-session config or Pi's credential alias. The original host names
    // are then explicitly removed from the restricted child environment.
    const model = this.resolveModel(request.model);
    const modelEnvironmentKeys = new Set([
      ...referencedEnvVars(request.model.api_key),
      ...referencedEnvVars(request.model.base_url),
    ]);
    const paths = this.prepareSessionPaths(request.sessionId);
    this.materializeModelsConfig(paths.configDir, model);
    this.materializeAgentsPrompt(request.workDir, request.systemPrompt);
    const invocation = piInvocationFor([
      '-p', '--mode', 'json', '--model', `sandbase/${model.model}`, '--session', paths.sessionFile,
    ], {
      command: this.command,
      commandArgs: this.commandArgs,
      platform: this.platform,
      environment: this.environment,
      fileExists: this.fileExists,
    });

    const env = restrictedPiEnvironment(this.environment, {
      PI_CODING_AGENT_DIR: paths.configDir,
      PI_TELEMETRY: '0',
      SANDBASE_PI_API_KEY: model.api_key,
    }, modelEnvironmentKeys);
    await spawnPiProcess(this.spawnImpl, invocation.file, invocation.args, {
      cwd: request.workDir,
      env,
      stdio: ['pipe', 'ignore', 'ignore'],
      windowsHide: true,
      // Detached POSIX children let an interrupt address the entire Pi process
      // group, including any CLI descendants that retain the workspace.
      detached: this.platform !== 'win32',
    }, request.prompt, request.abortSignal, {
      platform: this.platform,
      terminateProcess: this.terminateProcess,
      terminationGraceMs: this.terminationGraceMs,
      processGroupAlive: this.processGroupAlive,
    });
  }

  private prepareSessionPaths(sessionId: string): { sessionFile: string; configDir: string } {
    if (!/^sess_[A-Za-z0-9_-]+$/.test(sessionId)) {
      throw new Error('Pi session id is invalid');
    }
    const root = resolve(this.options.dataDir);
    const sessionsDir = resolve(root, 'pi-sessions');
    const sessionFile = resolve(sessionsDir, `${sessionId}.jsonl`);
    const configDir = resolve(sessionsDir, sessionId);
    assertInside(sessionsDir, sessionFile);
    assertInside(sessionsDir, configDir);
    ensurePrivateDirectory(sessionsDir, 'Pi session directory');
    ensurePrivateDirectory(configDir, 'Pi session configuration directory');
    // Pi expects a session target. Create it privately before placing its path
    // in argv, so the CLI never selects a different default session file.
    ensurePrivateFile(sessionFile, 'Pi session file');
    return { sessionFile, configDir };
  }

  private resolveModel(model: PiModelConfig): ResolvedPiModel {
    if (!model.model?.trim()) {
      throw new Error('Pi loop engine requires a selected model id');
    }
    if (!model.api_key) {
      throw new Error('Pi loop engine requires a configured model API key');
    }
    const api_key = resolveEnvVarsFrom(model.api_key, this.environment);
    if (api_key.includes('${')) {
      throw new Error('Pi loop engine model API key contains unresolved environment references');
    }
    const base_url = model.base_url
      ? resolveEnvVarsFrom(model.base_url, this.environment)
      : undefined;
    if (base_url?.includes('${')) {
      throw new Error('Pi loop engine model base URL contains unresolved environment references');
    }
    return { provider: model.provider, model: model.model, api_key, base_url };
  }

  private materializeModelsConfig(configDir: string, model: ResolvedPiModel): void {
    const providerConfig: Record<string, unknown> = {
      // Pi resolves this reference at request time; the literal key is never
      // serialized into the per-session configuration file.
      apiKey: '$SANDBASE_PI_API_KEY',
      api: model.provider === 'anthropic' ? 'anthropic-messages' : 'openai-completions',
      models: [{ id: model.model }],
    };
    if (model.base_url) providerConfig.baseUrl = model.base_url;
    const path = join(configDir, 'models.json');
    writePrivateFile(path, `${JSON.stringify({ providers: { sandbase: providerConfig } }, null, 2)}\n`, 'Pi models configuration');
  }

  private materializeAgentsPrompt(workDir: string, systemPrompt: string): void {
    const root = resolve(workDir);
    const path = resolve(root, 'AGENTS.md');
    assertInside(root, path);
    // A previous local-sandbox turn can create files in its work directory.
    // Refuse symlinks and atomically replace only a regular AGENTS.md, rather
    // than following a link outside the sandbox while preparing the next turn.
    writePrivateFile(path, systemPrompt, 'Pi AGENTS.md');
  }
}

/** Probe the executable only; it never receives user input or model credentials. */
export async function probePiCli(options: PiCliProbeOptions = {}): Promise<PiCliProbeResult> {
  let invocation: { file: string; args: string[] };
  try {
    invocation = piInvocationFor(['--version'], options);
  } catch {
    return { available: false, message: 'Pi CLI is not available.' };
  }
  try {
    await spawnPiProcess(
      options.spawnImpl ?? spawn,
      invocation.file,
      invocation.args,
      {
        env: restrictedPiEnvironment(options.environment ?? process.env, { PI_TELEMETRY: '0' }),
        stdio: 'ignore',
        windowsHide: true,
      },
    );
    return { available: true, message: 'Pi CLI is available.' };
  } catch {
    return { available: false, message: 'Pi CLI is not available.' };
  }
}

export function restrictedPiEnvironment(
  environment: NodeJS.ProcessEnv,
  additions: Record<string, string>,
  excludedKeys: ReadonlySet<string> = new Set(),
): Record<string, string> {
  const inherited = Object.fromEntries(
    INHERITED_ENVIRONMENT_KEYS.flatMap((key) => {
      const value = environment[key];
      return value === undefined || excludedKeys.has(key) ? [] : [[key, value]];
    }),
  );
  return { ...inherited, ...additions };
}

type PiProcessAbortOptions = {
  platform: NodeJS.Platform;
  terminateProcess: PiProcessTerminator;
  terminationGraceMs: number;
  processGroupAlive: PiProcessGroupInspector;
};

async function spawnPiProcess(
  spawnImpl: typeof spawn,
  file: string,
  args: string[],
  options: SpawnOptions,
  prompt?: string,
  abortSignal?: AbortSignal,
  abortOptions: PiProcessAbortOptions = {
    platform: process.platform,
    terminateProcess: terminatePiProcess,
    terminationGraceMs: 1_000,
    processGroupAlive: isProcessGroupAlive,
  },
): Promise<void> {
  if (abortSignal?.aborted) throw abortError();

  let child: ChildProcess;
  try {
    child = spawnImpl(file, args, options);
  } catch (error) {
    throw piLaunchError(error);
  }

  await new Promise<void>((resolvePromise, rejectPromise) => {
    let settled = false;
    let abortRequested = false;
    let childClosed = false;
    let windowsTreeTerminationComplete = false;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    const processGroupStillAlive = () => (
      abortOptions.platform !== 'win32'
      && child.pid !== undefined
      && abortOptions.processGroupAlive(child.pid)
    );
    const requestTermination = (force: boolean): Promise<void> => {
      try {
        return Promise.resolve(abortOptions.terminateProcess(child, abortOptions.platform, force));
      } catch {
        try {
          child.kill(force ? 'SIGKILL' : 'SIGTERM');
        } catch {
          // The child may already have exited; close/error will settle below.
        }
        return Promise.resolve();
      }
    };
    const onAbort = () => {
      if (abortRequested) return;
      abortRequested = true;
      const termination = requestTermination(false);
      if (abortOptions.platform === 'win32') {
        void termination.then(
          () => {
            windowsTreeTerminationComplete = true;
            if (childClosed) rejectOnce(abortError());
          },
          () => {
            // Do not settle: without confirmed task-tree completion, draining
            // the turn could release a workspace still held by a descendant.
          },
        );
      }
      if (abortOptions.platform !== 'win32' && abortOptions.terminationGraceMs > 0) {
        forceTimer = setTimeout(() => {
          void requestTermination(true);
          if (child.pid === undefined) return;
          void waitForProcessGroupExit(child.pid, abortOptions.processGroupAlive).then(() => {
            if (childClosed) rejectOnce(abortError());
          });
        }, abortOptions.terminationGraceMs);
      }
    };
    const cleanup = () => {
      if (forceTimer) clearTimeout(forceTimer);
      abortSignal?.removeEventListener('abort', onAbort);
    };
    const resolveOnce = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise();
    };
    const rejectOnce = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectPromise(piLaunchError(error));
    };

    child.once('error', (error) => {
      if (!abortRequested) {
        rejectOnce(error);
        return;
      }
      childClosed = true;
      if (abortOptions.platform === 'win32') {
        if (windowsTreeTerminationComplete) rejectOnce(abortError());
      } else if (!processGroupStillAlive()) {
        rejectOnce(abortError());
      }
    });
    child.once('close', (code) => {
      childClosed = true;
      if (abortRequested) {
        // Parent close is insufficient on POSIX: a child can retain the Pi
        // process group and workspace after its wrapper exits. Windows waits
        // for taskkill's tree-termination result for the same reason.
        if (abortOptions.platform === 'win32') {
          if (windowsTreeTerminationComplete) rejectOnce(abortError());
        } else if (!processGroupStillAlive()) {
          rejectOnce(abortError());
        }
      } else if (code === 0) {
        resolveOnce();
      } else {
        rejectOnce(new Error(`Pi process exited with code ${code ?? 'unknown'}`));
      }
    });

    if (abortSignal) {
      if (abortSignal.aborted) onAbort();
      else abortSignal.addEventListener('abort', onAbort, { once: true });
    }
    if (abortRequested || prompt === undefined) return;
    if (!child.stdin) {
      rejectOnce(new Error('Pi process did not expose stdin'));
      return;
    }
    child.stdin.once('error', (error) => {
      if (!abortRequested) rejectOnce(error);
    });
    try {
      child.stdin.end(prompt);
    } catch (error) {
      if (!abortRequested) rejectOnce(error);
    }
  });
}

/** Terminate Pi and any descendants that could retain the session workdir. */
function terminatePiProcess(
  child: ChildProcess,
  platform: NodeJS.Platform,
  force: boolean,
): void | Promise<void> {
  const signal = force ? 'SIGKILL' : 'SIGTERM';
  try {
    if (platform === 'win32' && child.pid) {
      // `taskkill /T` reaches Pi launched through an npm PowerShell shim; do
      // not interpolate a shell command or pass untrusted values here. Its
      // completion is part of cancellation: parent close alone cannot prove
      // a descendant no longer retains the session workspace.
      return new Promise((resolvePromise, rejectPromise) => {
        let settled = false;
        const resolveOnce = () => {
          if (settled) return;
          settled = true;
          resolvePromise();
        };
        const rejectOnce = (error: unknown) => {
          if (settled) return;
          settled = true;
          try {
            child.kill(signal);
          } catch {
            // The direct child may already have exited.
          }
          rejectPromise(error);
        };
        let killer: ChildProcess;
        try {
          killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], {
            stdio: 'ignore',
            windowsHide: true,
          });
        } catch (error) {
          rejectOnce(error);
          return;
        }
        killer.once('error', rejectOnce);
        killer.once('close', (code) => {
          if (code === 0) resolveOnce();
          else rejectOnce(new Error(`taskkill exited with code ${code ?? 'unknown'}`));
        });
      });
    }
    if (platform !== 'win32' && child.pid) {
      // Pi children launch detached on POSIX, so negative PID targets their
      // process group rather than only the wrapper executable.
      process.kill(-child.pid, signal);
      return;
    }
  } catch {
    // Fall back to the direct child below if the group/tree is already gone.
  }
  try {
    child.kill(signal);
  } catch {
    // The close/error handlers settle the launch promise if it is still live.
  }
}

function isProcessGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessGroupExit(
  pid: number,
  processGroupAlive: PiProcessGroupInspector,
): Promise<void> {
  while (processGroupAlive(pid)) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}

function abortError(): Error {
  const error = new Error('Pi process aborted');
  error.name = 'AbortError';
  return error;
}

function piLaunchError(error: unknown): Error {
  if (error instanceof Error && error.name === 'AbortError') return error;
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined;
  if (code === 'ENOENT') {
    return new Error('Pi CLI is not available. Install it and ensure "pi" is on PATH.');
  }
  if (error instanceof Error && /^Pi process exited with code/.test(error.message)) return error;
  return new Error('Pi CLI failed to launch.');
}

function ensurePrivateDirectory(path: string, label: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const entry = lstatSync(path);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error(`${label} must be a directory, not a symlink`);
  }
  chmodSync(path, 0o700);
}

function ensurePrivateFile(path: string, label: string): void {
  const entry = lstatIfPresent(path);
  if (entry) {
    assertPrivateRegularFile(entry, label);
  } else {
    // Exclusive creation never follows a newly planted symlink.
    writeFileSync(path, '', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  }
  chmodSync(path, 0o600);
}

/** Atomically replace a sandbox-controlled regular file without following links. */
function writePrivateFile(path: string, content: string, label: string): void {
  const existing = lstatIfPresent(path);
  if (existing) assertPrivateRegularFile(existing, label);

  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) rmSync(temporary, { force: true });
  }
}

function lstatIfPresent(path: string): NonNullable<ReturnType<typeof lstatSync>> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if (errorCodeIs(error, 'ENOENT')) return undefined;
    throw error;
  }
}

function assertPrivateRegularFile(
  entry: NonNullable<ReturnType<typeof lstatSync>>,
  label: string,
): void {
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) {
    throw new Error(`${label} must be a private regular file`);
  }
}

function errorCodeIs(error: unknown, code: string): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === code;
}

function assertInside(root: string, candidate: string): void {
  if (candidate === root || !candidate.startsWith(`${root}${sep}`)) {
    throw new Error('Pi session path escapes the runtime data directory');
  }
}

function resolveWindowsCommand(
  command: string,
  environment: NodeJS.ProcessEnv,
  fileExists: (path: string) => boolean,
): string {
  if (win32.isAbsolute(command) || command.includes('\\') || command.includes('/')) return command;
  const pathValue = environment.PATH;
  if (!pathValue) return command;
  const candidates = extname(command)
    ? [command]
    : [command, `${command}.cmd`, `${command}.exe`];
  for (const directory of pathValue.split(delimiter)) {
    if (!directory) continue;
    for (const candidate of candidates) {
      const fullPath = win32.join(directory, candidate);
      if (fileExists(fullPath)) return fullPath;
    }
  }
  return command;
}
