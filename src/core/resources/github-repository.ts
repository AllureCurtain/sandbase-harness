/**
 * GitHub repository resource contract (CMA `github_repository`).
 *
 * A mounted repository is a trusted part of the agent's instruction boundary:
 * its root `.claude/skills` becomes agent-visible skill content with no review
 * step, and the mount holds for the whole session. Both facts drive the shape
 * of this module — the URL grammar is enforced exactly, `checkout` is parsed
 * into a closed union instead of passed through, and the mount identity
 * (repository URL, checkout, mount path) is deliberately immutable after
 * session creation while only the authorization token may rotate.
 *
 * Rules from 访问GitHub.md and 智能体技能.md:
 * - `url` must be `https://github.com/<owner>/<repo>`, no `.git` suffix, no
 *   trailing path, no query or fragment. SSH and other hosts are rejected.
 * - `authorization_token` is required and never echoed back in a response.
 * - `mount_path` is optional, under `/workspace`, defaulting to
 *   `/workspace/<repo-name>`.
 * - `checkout` is optional: `{"type": "branch", "name": "..."}` or
 *   `{"type": "commit", "sha": "..."}`, defaulting to the repository default
 *   branch.
 * - Repository skills are discovered once per session from the repository
 *   root `.claude/skills/<name>/SKILL.md`, at one level of depth, and only
 *   when the agent's `read` tool stays enabled.
 *
 * Deliberately NOT implemented: cloning, caching, and real sandbox mounting.
 * This is a configuration contract, so a session that declares a repository is
 * stored faithfully and refused at execution admission rather than silently
 * pretending the repository is present.
 */

import { z } from 'zod';

/** Canonical resource-instance ID prefix, matching `sesrsc_01ABC...` in the docs. */
export const SESSION_RESOURCE_ID_PREFIX = 'sesrsc_';

/** Repository root directory scanned for skills. */
export const REPO_SKILLS_DIR = '.claude/skills';

/** Skill file name inside each skill directory. */
export const SKILL_FILE_NAME = 'SKILL.md';

/** Default mount root; a repository mounts under it. */
export const WORKSPACE_ROOT = '/workspace';

export type GithubCheckout =
  | { type: 'branch'; name: string }
  | { type: 'commit'; sha: string };

export interface GithubRepositoryResource {
  type: 'github_repository';
  /** Canonical HTTPS clone URL, always `https://github.com/<owner>/<repo>`. */
  url: string;
  /** `owner/repo`, derived from the URL. */
  repository: string;
  /** Repository name, used for the default mount path. */
  repositoryName: string;
  /** Absolute mount path under `/workspace`. */
  mountPath: string;
  /** Requested checkout, absent when the repository default branch applies. */
  checkout?: GithubCheckout;
}

export interface GithubResourceConfig {
  url: string;
  repository: string;
  repositoryName: string;
  mountPath: string;
  checkout?: GithubCheckout;
}

export type GithubResourceResult =
  | { ok: true; value: GithubResourceConfig }
  | { ok: false; message: string };

/**
 * Parse `https://github.com/<owner>/<repo>`.
 *
 * Accepts a single optional trailing `/`, matching the contract's
 * "a single trailing slash is ignored" hostname-comparison rule, and rejects:
 * any other host, a non-HTTPS scheme, an `.git` suffix, credentials, a port,
 * nested paths, and query or fragment components.
 */
export function parseGithubRepositoryUrl(raw: string): GithubResourceResult {
  const trimmed = raw.trim();
  const withoutSlash = trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;

  if (withoutSlash.includes('@') && !withoutSlash.startsWith('https://')) {
    return { ok: false, message: 'url must be an HTTPS URL like https://github.com/<owner>/<repo>; SSH URLs are not supported' };
  }
  if (withoutSlash.startsWith('git@') || withoutSlash.startsWith('ssh://')) {
    return { ok: false, message: 'url must be an HTTPS URL like https://github.com/<owner>/<repo>; SSH URLs are not supported' };
  }

  let parsed: URL;
  try {
    parsed = new URL(withoutSlash);
  } catch {
    return { ok: false, message: 'url must be an HTTPS URL like https://github.com/<owner>/<repo>' };
  }

  if (parsed.protocol !== 'https:') {
    return { ok: false, message: 'url must use https://; other schemes are not supported' };
  }
  if (parsed.hostname !== 'github.com') {
    return { ok: false, message: `url must point at github.com; "${parsed.hostname}" is not supported` };
  }
  if (parsed.search || parsed.hash) {
    return { ok: false, message: 'url must not include a query string or fragment' };
  }
  if (parsed.password) {
    return { ok: false, message: 'url must not include credentials' };
  }

  const segments = parsed.pathname.split('/').filter((segment) => segment.length > 0);
  if (segments.length !== 2) {
    return { ok: false, message: 'url must be exactly https://github.com/<owner>/<repo>' };
  }
  const [owner, repo] = segments as [string, string];
  if (repo.endsWith('.git')) {
    return { ok: false, message: 'url must not include a .git suffix' };
  }
  if (!isValidOwner(owner) || !isValidRepoName(repo)) {
    return { ok: false, message: 'url must be exactly https://github.com/<owner>/<repo> with a valid owner and repository name' };
  }

  const repositoryName = repo;
  return {
    ok: true,
    value: {
      url: `https://github.com/${owner}/${repo}`,
      repository: `${owner}/${repo}`,
      repositoryName,
      mountPath: `${WORKSPACE_ROOT}/${repositoryName}`,
    },
  };
}

/** GitHub logins: letters, digits, hyphens; may not start with a hyphen. */
function isValidOwner(value: string): boolean {
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(value) && value.length <= 39;
}

/** Repository names: letters, digits, `.`, `_`, `-`; not `.` or `..`. */
function isValidRepoName(value: string): boolean {
  if (value === '.' || value === '..') return false;
  return /^[A-Za-z0-9._-]+$/.test(value);
}

/**
 * Parse a `checkout` value.
 *
 * The published shape is a typed union, so a malformed value (an unknown
 * `type`, an empty `name`/`sha`, a bare string) is a request error rather than
 * a value the runtime carries forward and later cannot act on.
 */
export function parseCheckout(value: unknown): { ok: true; value?: GithubCheckout } | { ok: false; message: string } {
  if (value === undefined || value === null) return { ok: true };
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, message: 'checkout must be an object with a "branch" or "commit" type' };
  }
  const record = value as Record<string, unknown>;
  if (record.type === 'branch') {
    const name = record.name;
    if (typeof name !== 'string' || name.trim().length === 0) {
      return { ok: false, message: 'checkout.name is required for a branch checkout' };
    }
    return { ok: true, value: { type: 'branch', name: name.trim() } };
  }
  if (record.type === 'commit') {
    const sha = record.sha;
    if (typeof sha !== 'string' || sha.trim().length === 0) {
      return { ok: false, message: 'checkout.sha is required for a commit checkout' };
    }
    return { ok: true, value: { type: 'commit', sha: sha.trim() } };
  }
  return { ok: false, message: 'checkout.type must be "branch" or "commit"' };
}

/** Validate and normalize a mount path to an absolute path under `/workspace`. */
export function normalizeRepoMountPath(
  value: unknown,
  defaultPath: string,
): { ok: true; value: string } | { ok: false; message: string } {
  if (value === undefined || value === null) return { ok: true, value: defaultPath };
  if (typeof value !== 'string' || value.trim().length === 0) {
    return { ok: false, message: 'mount_path must be a non-empty string' };
  }
  const path = value.trim();
  if (!path.startsWith('/')) return { ok: false, message: 'mount_path must be an absolute path' };
  if (!path.startsWith(`${WORKSPACE_ROOT}/`) && path !== WORKSPACE_ROOT) {
    return { ok: false, message: `mount_path must be under ${WORKSPACE_ROOT}` };
  }
  if (path.includes('..')) return { ok: false, message: 'mount_path must not contain ..' };
  return { ok: true, value: path.replace(/\/+$/, '') || WORKSPACE_ROOT };
}

/** Absolute path of a repository's skills directory inside the sandbox. */
export function repoSkillsPath(mountPath: string): string {
  return `${mountPath}/${REPO_SKILLS_DIR}`;
}

/** Absolute path of one discovered skill's `SKILL.md`. */
export function repoSkillFilePath(mountPath: string, skillName: string): string {
  return `${repoSkillsPath(mountPath)}/${skillName}/${SKILL_FILE_NAME}`;
}

/**
 * Whether a path is a `.claude/skills/<name>/SKILL.md` entry at exactly one
 * level below the skills directory.
 *
 * Discovery is deliberately shallow: the contract states a nested layout such
 * as `.claude/skills/tools/code-review/SKILL.md` is not discovered at session
 * start, so a deeper match must not be announced as a session skill.
 */
export function isDiscoverableSkillPath(relativePath: string): boolean {
  const normalized = relativePath.replace(/^\/+/, '').replace(/\\/g, '/');
  const parts = normalized.split('/');
  if (parts.length !== 4) return false;
  const [dir, skills, name, file] = parts as [string, string, string, string];
  return dir === '.claude' && skills === 'skills' && name.length > 0 && file === SKILL_FILE_NAME;
}

/**
 * Extract a skill name from a repository-relative path, or `undefined` when
 * the path is not a discoverable session-start skill.
 */
export function discoverableSkillName(relativePath: string): string | undefined {
  if (!isDiscoverableSkillPath(relativePath)) return undefined;
  return relativePath.replace(/^\/+/, '').replace(/\\/g, '/').split('/')[2];
}

/** Deterministic ordering so a discovery listing is stable across runs. */
export function sortDiscoveredSkills(names: readonly string[]): string[] {
  return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}

// ============================================================
// Schema fragment
// ============================================================

export const githubCheckoutSchema = z.union([
  z.object({ type: z.literal('branch'), name: z.string().min(1, 'checkout.name is required for a branch checkout') }),
  z.object({ type: z.literal('commit'), sha: z.string().min(1, 'checkout.sha is required for a commit checkout') }),
]);
