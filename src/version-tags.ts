import semver from 'semver';

/**
 * Single source of truth for translating between npm version strings and
 * GitHub tag names.
 *
 * npm publishes `1.34.7`. GitHub tags it `v1.34.7`. Every lookup that crosses
 * that boundary goes through here — the prefix handling must not get scattered
 * as ad-hoc `'v' + version` string concatenation across modules, because the
 * convention is per-repository and the exceptions are what break you.
 */

/** Convert an npm version to the conventional GitHub tag form. */
export function toGitHubTag(npmVersion: string): string {
  const clean = semver.valid(npmVersion);

  if (!clean) {
    throw new Error(`Cannot build a tag from "${npmVersion}" — not valid semver.`);
  }

  return `v${clean}`;
}

/**
 * Convert a GitHub tag to a plain npm version.
 *
 * Handles the common shapes: `v1.34.7`, `1.34.7`, and monorepo-style
 * `whatsapp-web.js@1.34.7` / `whatsapp-web.js-v1.34.7`.
 * Returns null when nothing semver-shaped can be recovered.
 */
export function toNpmVersion(githubTag: string): string | null {
  const trimmed = githubTag.trim();

  // Fast path: already a bare version, or a plain v-prefix.
  const direct = semver.valid(trimmed) ?? semver.valid(trimmed.replace(/^v/i, ''));
  if (direct) {
    return direct;
  }

  // Monorepo tags put the package name in front — take the trailing version.
  const match = trimmed.match(/(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/);
  return match ? semver.valid(match[1]) : null;
}

/**
 * Tags to try, in order, when looking for the release matching a version.
 *
 * Not every project uses the `v` prefix — most do, some do not, and a few
 * changed convention partway through their history. Rather than guessing once
 * and reporting a spurious "no release found", callers try each candidate.
 */
export function candidateTags(npmVersion: string): string[] {
  const clean = semver.valid(npmVersion);

  if (!clean) {
    throw new Error(`Cannot build tag candidates from "${npmVersion}" — not valid semver.`);
  }

  return [`v${clean}`, clean];
}

/** True when two version-or-tag strings refer to the same release. */
export function isSameVersion(a: string, b: string): boolean {
  const versionA = toNpmVersion(a);
  const versionB = toNpmVersion(b);
  return versionA !== null && versionA === versionB;
}
