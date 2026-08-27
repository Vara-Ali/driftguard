import axios from 'axios';

/**
 * Internal-only HTTP wrapper for the MiniMax chat-completions endpoint.
 *
 * Both the Day 3 summarizer (`llm-client.ts`) and the Day 5 fix drafter
 * (`fix-generator.ts`) need to issue the same chat-completion POST and
 * retry with a "your previous response was not parseable JSON" nudge on
 * failure. Duplicating that logic across two modules would be a
 * maintenance trap, so it lives here as a private utility — not exported
 * through the main `llm-client.ts` surface because callers should go
 * through the typed verdict/fix functions, not raw HTTP.
 *
 * Anything outside `src/` should not import this file.
 */

export const API_URL = 'https://api.minimax.io/v1/chat/completions';
export const DEFAULT_MODEL = 'MiniMax-M2.7-highspeed';
const TEMPERATURE = 0;
const REQUEST_TIMEOUT_MS = 60_000;

export interface ChatCompletionResponse {
  choices?: { message?: { content?: string } }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export interface CallOptions {
  model: string;
  apiKey: string;
  system: string;
  user: string;
  /** When true, append an explicit retry nudge telling the model the last
   *  response was not parseable JSON. */
  retryForJson: boolean;
}

export interface RawCallResult {
  text: string;
  tokens: number;
  latencyMs: number;
}

/** Issue one chat completion. Network errors and non-2xx responses throw. */
export async function callOnce(options: CallOptions): Promise<RawCallResult> {
  const messages: { role: 'system' | 'user'; content: string }[] = [
    { role: 'system', content: options.system },
    { role: 'user', content: options.user },
  ];

  if (options.retryForJson) {
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