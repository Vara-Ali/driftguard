import 'dotenv/config';

// The `resolution-mode` attribute is required to pull a type out of an
// ESM-only package from a CommonJS file. Type-only, erased at runtime.
import type { Octokit as OctokitType } from '@octokit/rest' with { 'resolution-mode': 'import' };

/**
 * Day 6 smoke test for GitHub WRITE access.
 *
 * Before building PR logic, confirm GITHUB_TOKEN has write scope on a disposable
 * repo. We create a throwaway branch on `Vara-Ali/driftguard` (the project's own
 * repo — owned by the same user, not Recepta, and the branch is deleted
 * immediately after creation so nothing lingers), then delete it. That tells us
 * whether the token can create refs at all, which is the minimum Day 6 needs.
 *
 * Why not Recepta? Per the standing rule on this project, no write operation
 * points at Recepta without explicit user approval. DriftGuard is the disposable
 * target.
 *
 * Never throws. Returns a structured result so the caller can act on partial
 * success.
 */

const THROWAWAY_BRANCH = `driftguard/write-scope-smoke-${Date.now()}`;
const REPO_OWNER = 'Vara-Ali';
const REPO_NAME = 'driftguard';

interface SmokeResult {
  ok: boolean;
  step?: string;
  branch?: string;
  sha?: string;
  error?: string;
  /** True when the token is valid but lacks the scopes we need. */
  scopeMissing?: boolean;
}

async function main(): Promise<SmokeResult> {
  const token = process.env.GITHUB_TOKEN?.trim();
  if (!token || token === 'ghp_your_token_here') {
    return { ok: false, error: 'GITHUB_TOKEN is not set or is the placeholder value.' };
  }

  let Octokit: typeof OctokitType;
  try {
    ({ Octokit } = await import('@octokit/rest'));
  } catch (error) {
    return { ok: false, error: `Failed to load @octokit/rest: ${(error as Error).message}` };
  }

  const octokit = new Octokit({ auth: token });

  // Step 1: resolve the default branch HEAD.
  let baseSha: string;
  try {
    const ref = await octokit.rest.git.getRef({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      ref: `heads/main`,
    });
    baseSha = ref.data.object.sha;
  } catch (error) {
    return {
      ok: false,
      step: 'get base ref',
      error: `Could not read main ref on ${REPO_OWNER}/${REPO_NAME}: ${(error as Error).message}`,
    };
  }

  // Step 2: create the throwaway branch.
  try {
    await octokit.rest.git.createRef({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      ref: `refs/heads/${THROWAWAY_BRANCH}`,
      sha: baseSha,
    });
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 404 || status === 403) {
      return {
        ok: false,
        step: 'create ref',
        error: `Token rejected when creating branch (HTTP ${status}). Token likely lacks Contents: write scope.`,
        scopeMissing: true,
      };
    }
    return {
      ok: false,
      step: 'create ref',
      error: `createRef failed: ${(error as Error).message}`,
    };
  }

  // Step 3: immediately delete the throwaway branch.
  try {
    await octokit.rest.git.deleteRef({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      ref: `heads/${THROWAWAY_BRANCH}`,
    });
  } catch (error) {
    return {
      ok: false,
      step: 'delete ref',
      branch: THROWAWAY_BRANCH,
      error: `Branch ${THROWAWAY_BRANCH} was created but could not be deleted: ${(error as Error).message}. Delete it manually before continuing.`,
    };
  }

  return { ok: true, branch: THROWAWAY_BRANCH, sha: baseSha };
}

if (require.main === module) {
  main()
    .then((result) => {
      if (result.ok) {
        console.log(`WRITE-SCOPE SMOKE: OK`);
        console.log(`  created and deleted throwaway branch: ${result.branch}`);
        console.log(`  base sha (main): ${result.sha?.slice(0, 12)}...`);
        console.log(`  → GITHUB_TOKEN has Contents: write on ${REPO_OWNER}/${REPO_NAME}`);
        process.exit(0);
      }
      console.error(`WRITE-SCOPE SMOKE: FAILED — ${result.step ?? 'unknown step'}`);
      console.error(`  ${result.error}`);
      if (result.scopeMissing) {
        console.error('  → GITHUB_TOKEN is valid but lacks Contents: write scope.');
        console.error('  → Generate a fine-grained PAT scoped to Contents: write on ONE repo,');
        console.error('    or use a classic PAT with the `repo` scope.');
      }
      process.exit(1);
    })
    .catch((error) => {
      console.error('Unexpected failure:', error);
      process.exit(1);
    });
}

export { main as runWriteScopeSmoke, THROWAWAY_BRANCH };
