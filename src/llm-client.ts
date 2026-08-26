import axios from 'axios';

import { gatherChangeData, type ChangeData } from './gather-changes';
import { buildPrompt } from './prompts/summarize-change';

/**
 * LLM client for the breaking-change summarizer.
 *
 * Reuses the same MiniMax provider Recepta already talks to — the
 * OpenAI-compatible chat completions endpoint at api.minimax.io. The exact
 * shape (`{ model, messages, ... }` + Bearer auth) is OpenAI's, so swapping to
 * an actual OpenAI/Anthropic key later is a one-line change.
 *
 * Errors come back as `{ ok: false, ... }` rather than thrown, so the caller
 * can keep going on partial pipeline output.
 */

export type Confidence = 'high' | 'medium' | 'low';

export interface AffectedMethod {
  name: string;
  reason: string;
}

export interface Verdict {
  breaking: boolean;
  confidence: Confidence;
  affectedMethods: AffectedMethod[];
  summary: string;
  discrepancyNote: string | null;
}

export interface VerdictSuccess {
  ok: true;
  verdict: Verdict;
  /** Total wall-clock for the call(s) including the retry. */
  latencyMs: number;
  /** Total tokens consumed across all attempts. */
  totalTokens: number;
  /** True if the first response was unparseable and the retry succeeded. */
  retried: boolean;
  /** Model id that produced the verdict. */
  model: string;
}

export interface VerdictFailure {
  ok: false;
  error: string;
  latencyMs: number;
  totalTokens: number;
  /** Last raw text the model returned, for debugging. */
  rawOutput?: string;
  retried: boolean;
  model: string;
}

export type VerdictResult = VerdictSuccess | VerdictFailure;

export class MissingApiKeyError extends Error {
  constructor() {
    super('MINIMAX_API_KEY is not set — cannot call the LLM.');
    this.name = 'MissingApiKeyError';
  }
}

const API_URL = 'https://api.minimax.io/v1/chat/completions';

/** Default model — matches what Recepta uses in production. */
export const DEFAULT_MODEL = 'MiniMax-M2.7-highspeed';

/** Temperature zero: we want a verdict, not a creative take. */
const TEMPERATURE = 0;

const REQUEST_TIMEOUT_MS = 60_000;

/** Strict schema check. Better to fail loudly than to ship a wrong verdict. */
export function isVerdict(value: unknown): value is Verdict {
  if (typeof value !== 'object' || value === null) return false;

  const v = value as Record<string, unknown>;
  if (typeof v.breaking !== 'boolean') return false;
  if (v.confidence !== 'high' && v.confidence !== 'medium' && v.confidence !== 'low') return false;
  if (typeof v.summary !== 'string') return false;
  if (v.discrepancyNote !== null && typeof v.discrepancyNote !== 'string') return false;
  if (!Array.isArray(v.affectedMethods)) return false;

  for (const item of v.affectedMethods) {
    if (typeof item !== 'object' || item === null) return false;
    const m = item as Record<string, unknown>;
    if (typeof m.name !== 'string' || typeof m.reason !== 'string') return false;
  }

  return true;
}

/**
 * Models sometimes wrap JSON in ```json fences or prefix it with prose. Strip
 * the common noise before running the JSON parse. Falls back to throwing if
 * nothing JSON-shaped can be recovered.
 */
function extractJson(text: string): unknown {
  const trimmed = text.trim();

  // Fast path: already raw JSON.
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return JSON.parse(trimmed);
  }

  // Fenced ```json ... ``` block.
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    return JSON.parse(fenced[1].trim());
  }

  // First {...} span in the response.
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first !== -1 && last > first) {
    return JSON.parse(trimmed.slice(first, last + 1));
  }

  throw new Error('No JSON object found in response.');
}

interface ChatCompletionResponse {
  choices?: { message?: { content?: string } }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

interface CallOptions {
  model: string;
  apiKey: string;
  system: string;
  user: string;
  /** When true, the system message tells the model to fix a previous non-JSON reply. */
  retryForJson: boolean;
}

interface RawCallResult {
  text: string;
  tokens: number;
  latencyMs: number;
}

/**
 * Issue one chat completion. Network errors and non-2xx responses raise.
 * The verdict parsing is the caller's responsibility.
 */
async function callOnce(options: CallOptions): Promise<RawCallResult> {
  const messages: { role: 'system' | 'user'; content: string }[] = [
    { role: 'system', content: options.system },
    { role: 'user', content: options.user },
  ];

  if (options.retryForJson) {
    // Append the explicit retry nudge — system instructions are otherwise the
    // same, so the model knows the context but is being told the shape failed.
    messages.push({
      role: 'user',
      content:
        'Your previous response was not parseable JSON. Return ONLY the JSON object — ' +
        'no prose, no markdown, no code fences. The object must start with "{" and end ' +
        'with "}" and contain every required field from the schema.',
    });
  }

  const start = Date.now();

  const response = await axios.post<ChatCompletionResponse>(
    API_URL,
    {
      model: options.model,
      messages,
      temperature: TEMPERATURE,
    },
    {
      timeout: REQUEST_TIMEOUT_MS,
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        'Content-Type': 'application/json',
      },
    },
  );

  const text = response.data.choices?.[0]?.message?.content ?? '';
  const tokens = response.data.usage?.total_tokens ?? 0;

  return { text, tokens, latencyMs: Date.now() - start };
}

/**
 * Get a verdict for one upgrade.
 *
 * Tries once, retries once if the first response is not JSON, then gives up
 * with a structured failure result rather than throwing.
 */
export async function getVerdictForChange(
  change: ChangeData,
  options: { model?: string } = {},
): Promise<VerdictResult> {
  const apiKey = process.env.MINIMAX_API_KEY?.trim();
  if (!apiKey) {
    throw new MissingApiKeyError();
  }

  const model = options.model ?? DEFAULT_MODEL;
  const startedAt = Date.now();
  let totalTokens = 0;
  let lastRaw: string | undefined;

  const { system, user } = buildPrompt(change);

  // First attempt.
  let firstCall: RawCallResult;
  try {
    firstCall = await callOnce({ model, apiKey, system, user, retryForJson: false });
  } catch (error) {
    return {
      ok: false,
      error: `LLM call failed on first attempt: ${(error as Error).message}`,
      latencyMs: Date.now() - startedAt,
      totalTokens: 0,
      retried: false,
      model,
    };
  }

  totalTokens += firstCall.tokens;
  lastRaw = firstCall.text;

  let parsed: unknown;
  let firstParseError: string | null = null;
  try {
    parsed = extractJson(firstCall.text);
  } catch (error) {
    firstParseError = (error as Error).message;
  }

  // If first response parsed and looks like a verdict, we're done.
  if (!firstParseError && isVerdict(parsed)) {
    return {
      ok: true,
      verdict: parsed,
      latencyMs: Date.now() - startedAt,
      totalTokens,
      retried: false,
      model,
    };
  }

  // Retry — same prompt, explicit "your last response wasn't JSON" nudge.
  let retryCall: RawCallResult;
  try {
    retryCall = await callOnce({ model, apiKey, system, user, retryForJson: true });
  } catch (error) {
    return {
      ok: false,
      error: `LLM call failed on retry: ${(error as Error).message}`,
      latencyMs: Date.now() - startedAt,
      totalTokens,
      rawOutput: lastRaw,
      retried: true,
      model,
    };
  }

  totalTokens += retryCall.tokens;
  lastRaw = retryCall.text;

  try {
    parsed = extractJson(retryCall.text);
  } catch (error) {
    return {
      ok: false,
      error:
        `Could not parse the LLM output as JSON on either attempt. ` +
        `First: ${firstParseError ?? 'parse error'}. ` +
        `Retry: ${(error as Error).message}`,
      latencyMs: Date.now() - startedAt,
      totalTokens,
      rawOutput: lastRaw,
      retried: true,
      model,
    };
  }

  if (!isVerdict(parsed)) {
    return {
      ok: false,
      error: 'LLM returned JSON but it does not match the verdict schema.',
      latencyMs: Date.now() - startedAt,
      totalTokens,
      rawOutput: lastRaw,
      retried: true,
      model,
    };
  }

  return {
    ok: true,
    verdict: parsed,
    latencyMs: Date.now() - startedAt,
    totalTokens,
    retried: true,
    model,
  };
}

/** Convenience: gather change data and summarize in one call. */
export async function summarizeChange(
  packageName: string,
  oldVersion: string,
  newVersion: string,
  options: { model?: string } = {},
): Promise<{ data: ChangeData; verdict: VerdictResult }> {
  const data = await gatherChangeData(packageName, oldVersion, newVersion);
  const verdict = await getVerdictForChange(data, options);
  return { data, verdict };
}