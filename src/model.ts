/**
 * mushi — model interface (OpenAI-compatible + Ollama)
 */

import type { Message, ModelConfig } from './types.js';
import { estimateTokens, log } from './utils.js';

export async function callModel(
  modelConfig: ModelConfig,
  agentDir: string,
  context: string,
  prompt: string,
): Promise<string> {
  const messages: Message[] = [
    { role: 'system', content: context },
    { role: 'user', content: prompt },
  ];

  const { provider, base_url, model } = modelConfig;

  let url: string;
  let body: Record<string, unknown>;

  if (provider === 'ollama') {
    url = `${base_url}/api/chat`;
    body = {
      model, messages, stream: false,
      keep_alive: -1,          // never unload — eliminates cold start
      options: {
        num_predict: 512,      // cap response length — agents don't need essays
        num_ctx: 4096,         // tighter KV cache — reduces attention overhead
      },
    };
  } else {
    url = `${base_url}/v1/chat/completions`;
    body = { model, messages, stream: false };
  }

  log(agentDir, 'model', `calling ${provider}/${model} (context: ~${estimateTokens(context)} tokens)`);

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Model API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json() as Record<string, unknown>;

  if (provider === 'ollama') {
    const msg = data.message as { content: string } | undefined;
    return msg?.content ?? '';
  } else {
    const choices = data.choices as Array<{ message: { content: string } }> | undefined;
    return choices?.[0]?.message?.content ?? '';
  }
}
