import { getOctokit, hasGitHubToken } from './octokit-client';
import { getPackageMetadata, type GitHubRepoRef } from './npm-metadata';
import { candidateTags } from './version-tags';

/**
 * Fetches the human-written account of what changed in a release.
 *
 * For whatsapp-web.js that means GitHub Releases. The repo ships **no
 * CHANGELOG.md** — both casings 404 — but its release bodies are substantial
 * (~5,000 characters for v1.34.7), which makes them the real source of change
 * data for this package.
 *
 * FUTURE: plenty of packages do the opposite and maintain a CHANGELOG.md with
 * thin or absent GitHub Releases. When DriftGuard tracks a second package, add
 * a fallback here that fetches CHANGELOG.md via the contents API and slices out
 * the section for the requested version. Deliberately not built yet — there is
 * no package in scope that needs it, and an untested fallback is worse than an
 * honest "not found".
 */

export interface ReleaseNotesFound {
  found: true;
  /** The tag that actually matched, which may or may not carry a `v` prefix. */
  tag: string;
  /** Release title, often just the version. */
  name: string;
  /** The release body — the prose we actually care about. */
  body: string;
  publishedAt: string | null;
  url: string;
  isPrerelease: boolean;
  repo: GitHubRepoRef;
}

export interface ReleaseNotesMissing {
  found: false;
  reason: string;
  /** Tags that were tried, so the failure is diagnosable. */
  triedTags?: string[];
  repo?: GitHubRepoRef;
}

export type ReleaseNotesResult = ReleaseNotesFound | ReleaseNotesMissing;

/**
 * Fetch the GitHub Release body for a specific published version.
 *
 * Resolves the repository from the package's own npm metadata rather than from
 * local config — that way it stays correct when a project moves org, which
 * whatsapp-web.js did (pedroslopez → wwebjs).
 *
 * Never throws for the ordinary "there is no release for this version" case;
 * that comes back as `{ found: false, reason }`.
 */
export async function getReleaseNotes(
  packageName: string,
  version: string,
): Promise<ReleaseNotesResult> {
  if (!hasGitHubToken()) {
    return { found: false, reason: 'GITHUB_TOKEN is not configured.' };
  }

  let repo: GitHubRepoRef | null;

  try {
    const metadata = await getPackageMetadata(packageName, version);
    repo = metadata.repository;
  } catch (error) {
    return { found: false, reason: `Could not read npm metadata: ${(error as Error).message}` };
  }

  if (!repo) {
    return {
      found: false,
      reason: `${packageName} does not declare a GitHub repository in its npm metadata.`,
    };
  }

  const tags = candidateTags(version);
  const octokit = await getOctokit();

  for (const tag of tags) {
    try {
      const response = await octokit.rest.repos.getReleaseByTag({
        owner: repo.owner,
        repo: repo.repo,
        tag,
      });

      return {
        found: true,
        tag,
        name: response.data.name ?? tag,
        body: response.data.body ?? '',
        publishedAt: response.data.published_at ?? null,
        url: response.data.html_url,
        isPrerelease: response.data.prerelease,
        repo,
      };
    } catch (error) {
      const status = (error as { status?: number }).status;

      // 404 just means "not this tag" — try the next candidate.
      if (status === 404) {
        continue;
      }

      return {
        found: false,
        reason: `GitHub returned ${status ?? 'an error'} fetching release ${tag}: ${(error as Error).message}`,
        triedTags: tags,
        repo,
      };
    }
  }

  return {
    found: false,
    reason: `No GitHub Release exists for ${packageName}@${version}.`,
    triedTags: tags,
    repo,
  };
}
