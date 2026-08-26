import axios from 'axios';
import { NPM_REGISTRY, REQUEST_TIMEOUT_MS } from './config';

/**
 * Reads published version data for a package from the npm registry.
 *
 * Uses the abbreviated metadata format (`application/vnd.npm.install-v1+json`).
 * The full document for a long-lived package can run to several megabytes of
 * per-version detail we do not need here; the abbreviated form still carries
 * `dist-tags` and the full version list.
 */

/** Shape of the parts of the registry response we rely on. */
interface AbbreviatedPackument {
  name: string;
  'dist-tags': Record<string, string>;
  versions: Record<string, unknown>;
}

const ACCEPT_ABBREVIATED = 'application/vnd.npm.install-v1+json';

/** Raised when the registry cannot tell us about a package. */
export class RegistryError extends Error {
  constructor(message: string, readonly packageName: string) {
    super(message);
    this.name = 'RegistryError';
  }
}

/**
 * Fetch the raw packument for a package.
 *
 * Scoped names such as `@scope/pkg` are URL-encoded, so the slash becomes
 * `%2F` — the registry expects the whole name as a single path segment.
 */
async function fetchPackument(packageName: string): Promise<AbbreviatedPackument> {
  const url = `${NPM_REGISTRY}/${encodeURIComponent(packageName)}`;

  try {
    const response = await axios.get<AbbreviatedPackument>(url, {
      timeout: REQUEST_TIMEOUT_MS,
      headers: { Accept: ACCEPT_ABBREVIATED },
    });
    return response.data;
  } catch (error) {
    if (axios.isAxiosError(error)) {
      if (error.response?.status === 404) {
        throw new RegistryError(`Package "${packageName}" not found on the npm registry.`, packageName);
      }
      if (error.response) {
        throw new RegistryError(
          `Registry returned ${error.response.status} for "${packageName}".`,
          packageName,
        );
      }
      throw new RegistryError(
        `Could not reach the npm registry for "${packageName}": ${error.message}`,
        packageName,
      );
    }
    throw error;
  }
}

/**
 * Return the version currently published under the `latest` dist-tag.
 *
 * Note this is the maintainer's `latest` pointer, not simply the highest
 * semver. Those usually agree, but they diverge when a maintainer ships a
 * patch to an older line after a newer major — so read this as "what a plain
 * `npm install` would give you today".
 */
export async function getLatestVersion(packageName: string): Promise<string> {
  const packument = await fetchPackument(packageName);
  const latest = packument['dist-tags']?.latest;

  if (!latest) {
    throw new RegistryError(`Package "${packageName}" has no "latest" dist-tag.`, packageName);
  }

  return latest;
}

/**
 * Return every published version of a package, in registry order.
 *
 * Not needed for the Day 1 check, but Day 2 needs the intermediate versions
 * between tracked and latest to know which releases to read changes from.
 */
export async function getAllVersions(packageName: string): Promise<string[]> {
  const packument = await fetchPackument(packageName);
  return Object.keys(packument.versions ?? {});
}

/** Fetch the latest version and full version list in a single request. */
export async function getVersionInfo(
  packageName: string,
): Promise<{ latest: string; versions: string[] }> {
  const packument = await fetchPackument(packageName);
  const latest = packument['dist-tags']?.latest;

  if (!latest) {
    throw new RegistryError(`Package "${packageName}" has no "latest" dist-tag.`, packageName);
  }

  return { latest, versions: Object.keys(packument.versions ?? {}) };
}
