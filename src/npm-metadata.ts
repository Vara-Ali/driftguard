import axios from 'axios';
import { NPM_REGISTRY, REQUEST_TIMEOUT_MS } from './config';
import { RegistryError } from './registry';

/**
 * Per-version npm registry metadata.
 *
 * `registry.ts` answers "what versions exist"; this module answers "tell me
 * everything about *this* version" — publish date, deprecation, dependency
 * set, and where the source lives.
 */

export interface GitHubRepoRef {
  owner: string;
  repo: string;
  /** Sub-path within a monorepo, when the package declares one. */
  directory?: string;
}

export interface PackageMetadata {
  name: string;
  version: string;
  /** ISO timestamp this version was published, or null if the registry omits it. */
  publishedAt: string | null;
  /** Deprecation message if the version is deprecated, otherwise null. */
  deprecated: string | null;
  dependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
  /** Declared `types`/`typings` entry point, if the package ships them. */
  typesPath: string | null;
  /** Declared `main` entry point. */
  mainPath: string | null;
  /** Parsed GitHub repo, or null when the package does not declare a GitHub source. */
  repository: GitHubRepoRef | null;
  /** Raw `repository` field, kept for debugging odd shapes. */
  rawRepository: unknown;
}

/**
 * Publish timestamps live only on the full packument, which is large. Fetch it
 * at most once per package per process.
 */
const publishTimeCache = new Map<string, Record<string, string>>();

/**
 * Parse npm's `repository` field into an owner/repo pair.
 *
 * The field is famously loose — it may be a string shorthand, a string URL, or
 * an object, and the URL may be https, git://, git+ssh, or scp-style. Anything
 * that is not GitHub returns null rather than a wrong guess.
 */
export function parseRepository(field: unknown): GitHubRepoRef | null {
  if (!field) {
    return null;
  }

  let url: string;
  let directory: string | undefined;

  if (typeof field === 'string') {
    url = field;
  } else if (typeof field === 'object' && field !== null && 'url' in field) {
    url = String((field as { url: unknown }).url ?? '');
    const dir = (field as { directory?: unknown }).directory;
    directory = typeof dir === 'string' ? dir : undefined;
  } else {
    return null;
  }

  if (!url) {
    return null;
  }

  // `github:owner/repo` and the bare `owner/repo` shorthand.
  const shorthand = url.match(/^(?:github:)?([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
  if (shorthand) {
    return { owner: shorthand[1], repo: shorthand[2], directory };
  }

  // Any URL form pointing at github.com, including git+https, git://, and scp-style.
  const full = url.match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/#?].*)?$/);
  if (full) {
    return { owner: full[1], repo: full[2], directory };
  }

  return null;
}

/** Fetch (and cache) the publish-time map for a package. */
async function getPublishTimes(packageName: string): Promise<Record<string, string>> {
  const cached = publishTimeCache.get(packageName);
  if (cached) {
    return cached;
  }

  try {
    // Deliberately the full packument — the abbreviated form omits `time`.
    const response = await axios.get<{ time?: Record<string, string> }>(
      `${NPM_REGISTRY}/${encodeURIComponent(packageName)}`,
      { timeout: REQUEST_TIMEOUT_MS },
    );
    const times = response.data.time ?? {};
    publishTimeCache.set(packageName, times);
    return times;
  } catch {
    // A missing publish date is not worth failing the whole run over.
    publishTimeCache.set(packageName, {});
    return {};
  }
}

/**
 * Fetch the registry manifest for one specific version.
 *
 * Throws RegistryError if that exact version was never published.
 */
export async function getPackageMetadata(
  packageName: string,
  version: string,
): Promise<PackageMetadata> {
  const url = `${NPM_REGISTRY}/${encodeURIComponent(packageName)}/${encodeURIComponent(version)}`;

  let manifest: Record<string, unknown>;

  try {
    const response = await axios.get<Record<string, unknown>>(url, { timeout: REQUEST_TIMEOUT_MS });
    manifest = response.data;
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.status === 404) {
      throw new RegistryError(`Version ${version} of "${packageName}" was never published.`, packageName);
    }
    if (axios.isAxiosError(error)) {
      throw new RegistryError(
        `Registry lookup for ${packageName}@${version} failed: ${error.message}`,
        packageName,
      );
    }
    throw error;
  }

  const times = await getPublishTimes(packageName);

  return {
    name: String(manifest.name ?? packageName),
    version: String(manifest.version ?? version),
    publishedAt: times[version] ?? null,
    // npm sets `deprecated` to the deprecation message; absent means healthy.
    deprecated: typeof manifest.deprecated === 'string' ? manifest.deprecated : null,
    dependencies: (manifest.dependencies as Record<string, string>) ?? {},
    peerDependencies: (manifest.peerDependencies as Record<string, string>) ?? {},
    typesPath: (manifest.types as string) ?? (manifest.typings as string) ?? null,
    mainPath: (manifest.main as string) ?? null,
    repository: parseRepository(manifest.repository),
    rawRepository: manifest.repository ?? null,
  };
}

/**
 * Summarize what changed in the dependency set between two versions.
 * Cheap signal, and a dependency that appears or disappears often explains a
 * break better than the release notes do.
 */
export function diffDependencies(
  oldDeps: Record<string, string>,
  newDeps: Record<string, string>,
): { added: string[]; removed: string[]; changed: string[] } {
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];

  for (const [name, range] of Object.entries(newDeps)) {
    if (!(name in oldDeps)) {
      added.push(`${name}@${range}`);
    } else if (oldDeps[name] !== range) {
      changed.push(`${name}: ${oldDeps[name]} → ${range}`);
    }
  }

  for (const name of Object.keys(oldDeps)) {
    if (!(name in newDeps)) {
      removed.push(`${name}@${oldDeps[name]}`);
    }
  }

  return { added, removed, changed };
}
