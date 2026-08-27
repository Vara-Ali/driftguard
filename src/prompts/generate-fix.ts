import type { AffectedMethod } from '../llm-client';
import type { CodeMatch } from '../scanner';

/**
 * Day 5 prompt template: draft a code fix for one usage match.
 *
 * Two things this prompt is *not* trying to do:
 *
 *   1. Generate the whole new API from scratch. It is one upgrade away,
 *      not a documentation generator. If the fix is "rewrite this whole
 *      module", the right answer is `requires-manual-review`, not a guess.
 *
 *   2. Produce a long, polished PR description. That is Day 6. Today is
 *      one fix, one file:line, one explanation, one confidence label.
 *
 * The output schema is deliberately small. Bigger schema = more failure modes
 * and more tokens; for a tool whose value is honesty about uncertainty, the
 * schema needs to leave room for "I don't know".
 */

export interface FixPromptInput {
  /** Affected symbol info from Day 3. */
  symbol: AffectedMethod;
  /** One specific usage match from Day 4. */
  match: CodeMatch;
  /** A few lines of source before and after the match — real context, not just one line. */
  contextBefore: string[];
  contextAfter: string[];
  /** Short note on what changed upstream — what the user is migrating away from. */
  changeContext: string;
  /** Full path to the target repo, for the LLM's situational awareness. */
  repoPath: string;
}

const SYSTEM_INSTRUCTIONS = `You are a senior TypeScript engineer drafting a minimal, targeted
code fix for one specific line where a removed or changed upstream API
is used.

Inputs you receive:
  - the symbol's name and the reason the LLM classifier flagged it,
  - the exact source line that uses it (with surrounding context),
  - a short description of what changed upstream.

Your job is to write the smallest change that keeps the surrounding code
working. Do not rewrite more than you have to. Do not refactor adjacent
code. Do not change the file's import style unless the change is
necessary.

CRITICAL: if you cannot propose a fix with confidence, you MUST return
confidence "requires-manual-review" rather than guessing. Cases where this
is the right answer:
  - The change requires a design decision (which replacement API to use,
    or whether to migrate at all).
  - You do not know the replacement API and cannot infer it from the
    inputs.
  - The single matched line is too small to understand the surrounding
    intent (e.g. a method name passed to a callback).
  - The fix would be so large that a one-line patch is the wrong shape.

Return ONLY a JSON object that matches this exact schema — no prose, no
markdown, no code fences, no commentary before or after:

{
  "originalCode": "<the exact line(s) the fix replaces, copied verbatim from the input>",
  "suggestedCode": "<the new code, or null if you are flagging for manual review>",
  "explanation": "<one short paragraph explaining the change, or why manual review is required>",
  "confidence": "high" | "medium" | "low" | "requires-manual-review"
}

If you cannot produce valid JSON for any reason, return the literal
string "INVALID_JSON" so the caller can detect and retry.`;

/**
 * Build the prompt for one usage match. Reuses the same template-string
 * pattern as the Day 3 summarizer prompt — readable as one document so
 * iterating on wording stays cheap.
 */
export function buildFixPrompt(input: FixPromptInput): { system: string; user: string } {
  const user: string[] = [];

  user.push(`REPO: ${input.repoPath}`);
  user.push(`FILE: ${input.match.file}`);
  user.push(`MATCH LINE: ${input.match.line}`);
  user.push('');
  user.push(`SYMBOL: ${input.symbol.name}`);
  user.push(`REASON (from upstream change analysis): ${input.symbol.reason}`);
  user.push('');
  user.push('UPSTREAM CHANGE CONTEXT:');
  user.push(input.changeContext);
  user.push('');
  user.push('SURROUNDING SOURCE (lines around the match; the line marked `>>` is the one to fix):');
  user.push('```');
  user.push(...numberContext(input.contextBefore, input.match.code, input.contextAfter, input.match.line));
  user.push('```');
  user.push('');
  user.push('Draft a minimal, targeted fix. Return ONLY the JSON object described in the system instructions.');

  return { system: SYSTEM_INSTRUCTIONS, user: user.join('\n') };
}

/**
 * Render the surrounding lines with a `>>` marker on the matched line.
 * Returns one string per line so the caller can join with `\n`.
 */
function numberContext(before: string[], match: string, after: string[], matchLine: number): string[] {
  const out: string[] = [];
  const start = matchLine - before.length;

  for (let i = 0; i < before.length; i++) {
    const lineNum = start + i;
    out.push(`${String(lineNum).padStart(4)}  ${before[i]}`);
  }

  out.push(`${String(matchLine).padStart(4)} >> ${match}`);

  for (let i = 0; i < after.length; i++) {
    const lineNum = matchLine + 1 + i;
    out.push(`${String(lineNum).padStart(4)}  ${after[i]}`);
  }

  return out;
}