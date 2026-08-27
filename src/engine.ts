/**
 * Phase 1 — engine barrel.
 *
 * Re-exports the five pure, independently callable pipeline functions that
 * Days 2–6 produced, so the CLI wrapper in `src/index.ts` and the new
 * Express server in `apps/api/src/server.ts` can both `import { ... } from
 * '../../src/engine'` without duplicating the surface.
 *
 * Nothing here does I/O beyond what the underlying functions already do.
 * Nothing here reads `process.argv` or writes to `console`. The CLI wrapper
 * is the only thing that knows about stdout; the server is the only thing
 * that knows about HTTP.
 */

export { gatherChangeData, formatChangeData, type ChangeData } from './gather-changes';
export {
  getVerdictForChange,
  summarizeChange,
  isVerdict,
  MissingApiKeyError,
  type Verdict,
  type VerdictResult,
  type AffectedMethod,
  type Confidence,
} from './llm-client';
export { findUsages, formatScanResult, type ScanResult, type SymbolUsage, type CodeMatch } from './scanner';
export {
  draftFixesForChange,
  readContextLines,
  sanitizeAffectedMethods,
  isFixSuggestion,
  type FixDraft,
  type FixSuggestion,
  type FixConfidence,
} from './fix-generator';
export { saveReport, renderReport, announceReport, reportFileName } from './report';
export {
  runOpenPr,
  createFixBranch,
  applyFixesToFiles,
  pushBranch,
  openDraftPR,
  renderPrBody,
  buildBranchName,
  buildPrTitle,
  type RepoRef,
  type BranchResult,
  type ApplyResult,
  type PushResult,
  type OpenPrResult,
  type OpenPrOrchestratorResult,
} from './git-actions';