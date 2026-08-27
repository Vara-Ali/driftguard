# DriftGuard

A working agent that detects silent breaking changes in a tracked npm
dependency and opens a draft pull request with code fixes for a human
to review.

## What it does, end-to-end

Given a tracked dependency, a target codebase, and a fine-grained GitHub
PAT scoped to a disposable target repo, `npm run dev -- --from <old> --to
<new> --summarize --scan --scan-path <target> --suggest-fixes --open-pr`
runs this pipeline:

1. **Drift check.** Pulls the latest published version of the dependency
   from the npm registry and compares it to the version pinned in
   `src/config.ts`. Reports "behind by X" or "up to date".
2. **Change retrieval.** For an explicit `--from <old> --to <new>` pair,
   pulls the GitHub Release body, the npm registry metadata for both
   versions, and a type-definition diff (via unpkg) between them. The
   type diff is normalized to strip whitespace and comment noise — see
   the Day 2 log for why.
3. **LLM verdict.** Asks the model for a structured verdict
   `{ breaking, confidence, affectedMethods[], summary, discrepancyNote }`.
   The `discrepancyNote` field is the strongest signal — it catches the
   case where the release notes downplay a breaking change that the
   type diff reveals.
4. **Codebase scan.** Searches the target repo for real usages of every
   affected symbol. Filters out node_modules, dist, build, coverage,
   `.next`, `.nuxt`, `.output`, and other obvious-noise directories.
   Falls back from ripgrep to a manual walker when ripgrep isn't
   installed.
5. **Fix drafting.** For each real match, reads 5 lines of context
   before and after, asks the LLM for a minimal code fix with a
   confidence label, and assembles a Markdown report under `reports/`.
   The schema has `requires-manual-review` as a first-class verdict
   so the LLM can flag "this needs a human" honestly rather than fake
   a fix.
6. **Draft PR.** When `--open-pr` is set, creates a new branch off the
   target's base, applies only HIGH-confidence fixes to disk, commits,
   pushes, and opens a DRAFT PR via Octokit. The PR body is the Day 5
   Markdown report with HIGH-confidence items pre-checked and the rest
   as a manual-review checklist. DriftGuard never auto-merges.

## Live demo

`npm run dev -- --from 1.34.6 --to 1.34.7 --summarize --scan --scan-path
/mnt/c/Users/Vara/projects/driftguard-e2e --suggest-fixes --open-pr
--pr-owner Vara-Ali --pr-repo driftguard-e2e-target --pr-base main`

That command ran on 2026-08-27 and produced:
**https://github.com/Vara-Ali/driftguard-e2e-target/pull/1** — a draft PR
on a disposable target repo, with HIGH-confidence fixes auto-applied and
the remaining suggestions as a manual-review checklist.

## What it doesn't do (yet)

- **Single dependency at a time.** Multi-package support is a future
  version.
- **Manual CLI invocation.** No scheduled runs, no GitHub webhook
  integration. Every run is `npm run dev -- ...`.
- **Conservative file-drift guard.** If multiple HIGH-confidence fixes
  target the same file, they're applied atomically now, but a fix that
  spans a region around the matched line still needs a fuzzy-match
  strategy we don't have.
- **One tested package.** Validated against `whatsapp-web.js` only.
  Other packages (especially hand-written `.d.ts`) may produce diff
  shapes the parser doesn't handle.

## Honest test results

| Case | Verdict | Real matches | Outcome |
|------|---------|--------------|---------|
| Recepta vs 1.34.6 → 1.34.7 | BREAKING | 0 | True negative — no exposure in Recepta |
| Recepta vs 1.34.7 → 2.0.0-alpha.0 | BREAKING | 0 real | Noise-dominated — surface matches were minified bundles and prose |
| Synthetic fixture vs 1.34.6 → 1.34.7 | BREAKING | 32 | Real positive — full pipeline, real draft PR opened |

DriftGuard doesn't cry wolf. The first two cases correctly produced no
actionable output; only the third produced a real PR.

## Running it

Use the **WSL** shell, not PowerShell — see Day 1 note 3.

```bash
npm install
cp .env.example .env   # add a real GITHUB_TOKEN and MINIMAX_API_KEY
npm run dev            # default drift check
npm run check:github   # GitHub auth smoke test
npm run verify         # Day 3 LLM ground-truth validator

# Full end-to-end against a disposable clone of your target repo
npm run dev -- --from 1.34.6 --to 1.34.7 --summarize \
  --scan --scan-path /path/to/disposable-clone \
  --suggest-fixes --open-pr \
  --pr-owner YOU --pr-repo your-e2e-target --pr-base main
```

## Tech stack

Node.js 20, TypeScript 5.9 (CommonJS, `ts-node`), Octokit for the GitHub
API, axios for HTTP, semver for version comparison, MiniMax (or any
OpenAI-compatible endpoint) for the LLM.

Two pins are deliberate: TypeScript must stay on 5.x (ts-node can't load
TypeScript 7), and Octokit must be loaded via dynamic `import()` (it's
ESM-only).

## Build log

See [PROJECT.md](./PROJECT.md) for the day-by-day build log, including
the honest "what worked / what didn't" notes from each day.
