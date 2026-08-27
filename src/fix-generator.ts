import * as fs from 'fs';
import * as path from 'path';

import { summarizeChange } from './llm-client';
import {
  getVerdictForChange,
  MissingApiKeyError,
  type AffectedMethod,
  type VerdictResult,
} from './llm-client';
import { findUsages, type CodeMatch, type SymbolUsage, type ScanResult } from './scanner';
import { buildFixPrompt } from './prompts/generate-fix';
import { callOnce } from './llm-client-internal';

/**
 * Maximum number of symbols we will search for / draft fixes against.
 *
 * The LLM can return arbitrarily many affectedMethods. With 100+ entries
 * the scanner starts producing noise matches on generic names and the
 * downstream fix-generation cost balloons. Cap to the top entries by
 * declared order — the LLM ranks them by severity in its response.
 */
const MAX_FIX_SYMBOLS = 20;

/** Accept only entries whose `name` looks like a real TS identifier. */
function isLikelyIdentifier(name: unknown): name is string {
  return typeof name === 'string' && /^[A-Za-z_$][\w$]*$/.test(name);
}

/**
 * Reduce a verdict's affectedMethods to ones the scanner will find useful:
 *   - drop entries whose name is not a valid identifier (the LLM sometimes
 *     leaks prose summaries like "170 exported symbols removed" into the
 *     affectedMethods list and they return zero matches),
 *   - cap to MAX_FIX_SYMBOLS so a 170-removal blast radius does not
 *     silently cost N LLM calls.
 */
export function sanitizeAffectedMethods(
  methods: AffectedMethod[],
): AffectedMethod[] {
  const seen = new Set<string>();
  const out: AffectedMethod[] = [];
  for (const method of methods) {
    if (!isLikelyIdentifier(method.name)) continue;
    if (seen.has(method.name)) continue;
    seen.add(method.name);
    out.push(method);
    if (out.length >= MAX_FIX_SYMBOLS) break;
  }
  return out;
}

/**
 * Day 5: per-usage fix drafter.
 *
 * For each real usage match found by Day 4, read a few lines of surrounding
 * source for context, then ask the LLM for a minimal code fix. Results are
 * collected per-symbol, with an explicit `requires-manual-review` verdict
 * when the LLM does not have enough to make a confident mechanical change.
 *
 * Cost note: one LLM call per match, so a scan that returns N matches
 * costs N tokens-of-prompt × ~2k each. A real fix drafter would batch,
 * but per-match is the right shape for an MVP — easier to reason about,
 * and easier to fall back per-call.
 */

export type FixConfidence = 'high' | 'medium' | 'low' | 'requires-manual-review';

export interface FixSuggestion {
  /** Symbol this fix is for. */
  symbolName: string;
  /** Reason from the Day 3 verdict, carried through for context. */
  symbolReason: string;
  /** Source location the fix applies to. */
  file: string;
  line: number;
  /** Verbatim original line(s) the fix replaces. */
  originalCode: string;
  /** The LLM's suggested replacement, or null when flagged for manual review. */
  suggestedCode: string | null;
  /** Plain-English explanation, or "why manual review is required". */
  explanation: string;
  /** Honest confidence label. */
  confidence: FixConfidence;
  /** True when the LLM call or JSON parse failed for this match. */
  error?: string;
}

export interface FixDraft {
  packageName: string;
  oldVersion: string;
  newVersion: string;
  targetRepoPath: string;
  /** Per-symbol, per-match fixes in the order they were processed. */
  suggestions: FixSuggestion[];
  /** Grouped view: same data, indexed by symbol name. */
  bySymbol: Record<string, FixSuggestion[]>;
  /** Aggregate counters for quick summary. */
  totals: {
    symbolsWithMatches: number;
    suggestions: number;
    highConfidence: number;
    mediumConfidence: number;
    lowConfidence: number;
    manualReview: number;
    errors: number;
  };
}

/** Number of source lines to include before and after a matched line. */
const CONTEXT_LINES = 5;

/**
 * Read `contextLines` lines before and after the matched line from the file
 * on disk. Returns empty arrays if the file is unreadable — the LLM gets
 * only the matched line, which is usually enough for type/API errors but
 * may push the confidence toward "requires-manual-review".
 */
export function readContextLines(
  repoPath: string,
  file: string,
  line: number,
  contextLines: number = CONTEXT_LINES,
): { before: string[]; after: string[] } {
  const abs = path.isAbsolute(file) ? file : path.join(repoPath, file);
  let content: string;

  try {
    content = fs.readFileSync(abs, 'utf8');
  } catch {
    return { before: [], after: [] };
  }

  const lines = content.split('\n');
  const before = lines.slice(Math.max(0, line - 1 - contextLines), line - 1);
  const after = lines.slice(line, Math.min(lines.length, line + contextLines));

  return { before, after };
}

interface FixCallOptions {
  model?: string;
  /** Surrounding-line window per match. */
  contextLines?: number;
}

/**
 * Issue one fix-draft call. Internal — extractJson / isFixSuggestion / etc.
 * are intentionally not exposed. Mirrors `getVerdictForChange`'s shape but
 * for the smaller fix schema.
 */
async function draftOneFix(
  symbol: AffectedMethod,
  match: CodeMatch,
  repoPath: string,
  changeContext: string,
  apiKey: string,
  model: string,
  contextLines: number,
): Promise<FixSuggestion> {
  const { before, after } = readContextLines(repoPath, match.file, match.line, contextLines);
  const { system, user } = buildFixPrompt({
    symbol,
    match,
    contextBefore: before,
    contextAfter: after,
    changeContext,
    repoPath,
  });

  let parsed: unknown;
  let retried = false;
  let rawText = '';

  try {
    const first = await callOnce({ model, apiKey, system, user, retryForJson: false });
    rawText = first.text;
    parsed = tryParseJson(first.text);
  } catch (error) {
    return toErrorSuggestion(symbol, match, `Fix call failed: ${(error as Error).message}`);
  }

  if (parsed === undefined) {
    retried = true;
    try {
      const retry = await callOnce({ model, apiKey, system, user, retryForJson: true });
      rawText = retry.text;
      parsed = tryParseJson(retry.text);
    } catch (error) {
      return toErrorSuggestion(symbol, match, `Fix call failed on retry: ${(error as Error).message}`);
    }
  }

  if (parsed === undefined) {
    return toErrorSuggestion(
      symbol,
      match,
      `Could not parse fix JSON on either attempt. Raw response starts: ${rawText.slice(0, 200)}`,
    );
  }

  if (!isFixSuggestion(parsed)) {
    return toErrorSuggestion(
      symbol,
      match,
      `LLM returned JSON but it does not match the fix schema. Raw: ${rawText.slice(0, 200)}`,
    );
  }

  return {
    symbolName: symbol.name,
    symbolReason: symbol.reason,
    file: match.file,
    line: match.line,
    originalCode: parsed.originalCode ?? match.code,
    suggestedCode: parsed.suggestedCode ?? null,
    explanation: parsed.explanation ?? '(no explanation provided)',
    confidence: parsed.confidence,
    ...(retried ? { error: '(succeeded on retry)' } : {}),
  };
}

/**
 * Parse the LLM response as JSON, tolerating:
 *   - leading/trailing whitespace,
 *   - <think>...</think> reasoning blocks (some models emit these before the answer),
 *   - ```json fenced blocks,
 *   - the first {...} span if prose surrounds the JSON.
 *
 * Returns undefined when nothing JSON-shaped can be recovered.
 */
function tryParseJson(text: string): unknown {
  let trimmed = text.trim();

  // Strip leading reasoning blocks (MiniMax-M2.7-highspeed uses <think>).
  const thinkOpen = trimmed.indexOf('<think>');
  if (thinkOpen !== -1) {
    const thinkClose = trimmed.indexOf('</think>', thinkOpen);
    if (thinkClose !== -1) {
      trimmed = (trimmed.slice(0, thinkOpen) + trimmed.slice(thinkClose + 8)).trim();
    }
  }

  // Fast path: already raw JSON.
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // fall through
    }
  }

  // Fenced ```json ... ``` block.
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      // fall through
    }
  }

  // First {...} span in the response.
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first !== -1 && last > first) {
    try {
      return JSON.parse(trimmed.slice(first, last + 1));
    } catch {
      // fall through
    }
  }

  return undefined;
}

function toErrorSuggestion(symbol: AffectedMethod, match: CodeMatch, error: string): FixSuggestion {
  return {
    symbolName: symbol.name,
    symbolReason: symbol.reason,
    file: match.file,
    line: match.line,
    originalCode: match.code,
    suggestedCode: null,
    explanation: 'Fix generation failed before a verdict was produced.',
    confidence: 'requires-manual-review',
    error,
  };
}

/**
 * Strict schema check for one fix.
 */
export function isFixSuggestion(value: unknown): value is {
  originalCode: string;
  suggestedCode: string | null;
  explanation: string;
  confidence: FixConfidence;
} {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.suggestedCode !== null && typeof v.suggestedCode !== 'string') return false;
  if (typeof v.explanation !== 'string') return false;
  if (v.confidence !== 'high' && v.confidence !== 'medium' && v.confidence !== 'low' && v.confidence !== 'requires-manual-review') {
    return false;
  }
  if (typeof v.originalCode !== 'string') return false;
  return true;
}

/**
 * Aggregate fix suggestions by symbol for the report.
 */
function groupBySymbol(suggestions: FixSuggestion[]): Record<string, FixSuggestion[]> {
  const out: Record<string, FixSuggestion[]> = {};
  for (const suggestion of suggestions) {
    if (!out[suggestion.symbolName]) out[suggestion.symbolName] = [];
    out[suggestion.symbolName].push(suggestion);
  }
  return out;
}

function summarizeTotals(suggestions: FixSuggestion[], symbolsWithMatches: number): FixDraft['totals'] {
  let high = 0, medium = 0, low = 0, manual = 0, errors = 0;
  for (const s of suggestions) {
    if (s.error) errors += 1;
    if (s.confidence === 'high') high += 1;
    else if (s.confidence === 'medium') medium += 1;
    else if (s.confidence === 'low') low += 1;
    else manual += 1;
  }
  return {
    symbolsWithMatches,
    suggestions: suggestions.length,
    highConfidence: high,
    mediumConfidence: medium,
    lowConfidence: low,
    manualReview: manual,
    errors,
  };
}

/**
 * Build the one-paragraph change-context summary that goes into every fix
 * prompt. Tells the LLM what the upstream is migrating away from, so it
 * does not have to infer the migration target from the symbol name alone.
 */
function buildChangeContext(
  packageName: string,
  oldVersion: string,
  newVersion: string,
  verdict: VerdictResult,
): string {
  const parts: string[] = [];
  parts.push(`${packageName} is being upgraded from ${oldVersion} to ${newVersion}.`);

  if (verdict.ok) {
    const v = verdict.verdict;
    parts.push('');
    parts.push(`Breaking change: ${v.breaking}`);
    parts.push(`Confidence: ${v.confidence}`);
    parts.push(`Maintainer summary: ${v.summary}`);
    if (v.discrepancyNote) {
      parts.push(`Discrepancy between release notes and types: ${v.discrepancyNote}`);
    }
    if (v.affectedMethods.length > 0) {
      parts.push('');
      parts.push('Affected methods/exports:');
      for (const m of v.affectedMethods) {
        parts.push(`  - ${m.name}: ${m.reason}`);
      }
    }
  } else {
    parts.push('');
    parts.push(`LLM verdict was not available: ${verdict.error}`);
  }

  return parts.join('\n');
}

/**
 * End-to-end Day 5: gather → verdict → scan → fix per match → return draft.
 *
 * The `summarizeChange` call is shared with Day 3 — no point running it
 * twice. `findUsages` only runs when the verdict says `breaking=true`; same
 * gating as the standalone `--scan` path.
 */
export async function draftFixesForChange(
  packageName: string,
  oldVersion: string,
  newVersion: string,
  targetRepoPath: string,
  options: FixCallOptions = {},
): Promise<FixDraft> {
  const apiKey = process.env.MINIMAX_API_KEY?.trim();
  if (!apiKey) {
    throw new MissingApiKeyError();
  }

  const model = options.model ?? 'MiniMax-M2.7-highspeed';
  const contextLines = options.contextLines ?? CONTEXT_LINES;

  // 1. Get the verdict (Day 3 path).
  const { verdict } = await summarizeChange(packageName, oldVersion, newVersion);

  if (!verdict.ok) {
    return emptyDraft(packageName, oldVersion, newVersion, targetRepoPath, verdict);
  }

  if (!verdict.verdict.breaking) {
    return emptyDraft(packageName, oldVersion, newVersion, targetRepoPath, verdict);
  }

  // 2. Scan the target repo for affected symbols (Day 4 path).
  //    Sanitize first: drop prose entries the LLM occasionally leaks into
  //    the affectedMethods list (e.g. "170 exported symbols removed") and
  //    cap to MAX_FIX_SYMBOLS so a 170-removal blast radius does not
  //    silently fan out to hundreds of LLM calls.
  const sanitized = sanitizeAffectedMethods(verdict.verdict.affectedMethods);
  const scan: ScanResult = await findUsages(sanitized, targetRepoPath);

  if (!scan.scanned || scan.usages.length === 0) {
    return emptyDraft(packageName, oldVersion, newVersion, targetRepoPath, verdict);
  }

  const changeContext = buildChangeContext(packageName, oldVersion, newVersion, verdict);
  const symbolsWithMatches = scan.usages.filter((u) => u.matchCount > 0);

  // 3. One LLM call per match. Sequential so a model failure on one match
  //    does not block the others — and so the rate-limit budget is not
  //    blown on a single broken symbol.
  const suggestions: FixSuggestion[] = [];
  for (const usage of symbolsWithMatches) {
    for (const match of usage.matches) {
      const suggestion = await draftOneFix(
        { name: usage.symbolName, reason: usage.reason },
        match,
        targetRepoPath,
        changeContext,
        apiKey,
        model,
        contextLines,
      );
      suggestions.push(suggestion);
    }
  }

  return {
    packageName,
    oldVersion,
    newVersion,
    targetRepoPath,
    suggestions,
    bySymbol: groupBySymbol(suggestions),
    totals: summarizeTotals(suggestions, symbolsWithMatches.length),
  };
}

function emptyDraft(
  packageName: string,
  oldVersion: string,
  newVersion: string,
  targetRepoPath: string,
  verdict: VerdictResult,
): FixDraft {
  return {
    packageName,
    oldVersion,
    newVersion,
    targetRepoPath,
    suggestions: [],
    bySymbol: {},
    totals: summarizeTotals([], 0),
  };
}