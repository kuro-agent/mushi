/**
 * mushi — model interface (OpenAI-compatible + Ollama + Taalas HC1)
 */

import type { Message, ModelConfig } from './types.js';
import { estimateTokens, log } from './utils.js';

interface ProviderConfig {
  provider: string;
  base_url: string;
  model: string;
  api_key?: string;
  chat_template_kwargs?: Record<string, unknown>;
}

async function callProvider(
  prov: ProviderConfig,
  messages: Message[],
): Promise<string> {
  const { provider, base_url, model, api_key } = prov;

  let url: string;
  let body: Record<string, unknown>;

  if (provider === 'taalas') {
    url = `${base_url}/api/chat`;
    body = {
      messages,
      chatOptions: { selectedModel: model },
    };
  } else if (provider === 'ollama') {
    url = `${base_url}/api/chat`;
    body = {
      model, messages, stream: false,
      keep_alive: -1,
      options: {
        num_predict: 512,
        num_ctx: 4096,
      },
    };
  } else {
    url = `${base_url}/v1/chat/completions`;
    body = { model, messages, stream: false };
    if (prov.chat_template_kwargs) {
      body.chat_template_kwargs = prov.chat_template_kwargs;
    }
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(api_key ? { Authorization: `Bearer ${api_key}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new Error(`${provider} API error: ${response.status} ${response.statusText}`);
  }

  if (provider === 'taalas') {
    // Vercel AI SDK text format: response text + <|stats|>{...}<|/stats|>
    const text = await response.text();
    return text.replace(/<\|stats\|>[\s\S]*?<\|\/stats\|>/g, '').trim();
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

  const primary: ProviderConfig = {
    provider: modelConfig.provider,
    base_url: modelConfig.base_url,
    model: modelConfig.model,
    api_key: modelConfig.api_key,
    chat_template_kwargs: modelConfig.chat_template_kwargs,
  };

  log(agentDir, 'model', `calling ${primary.provider}/${primary.model} (context: ~${estimateTokens(context)} tokens)`);

  try {
    return await callProvider(primary, messages);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'unknown';

    if (modelConfig.fallback) {
      const fb = modelConfig.fallback;
      log(agentDir, 'model', `${primary.provider} failed (${errMsg}), falling back to ${fb.provider}/${fb.model}`);
      return await callProvider({
        provider: fb.provider,
        base_url: fb.base_url,
        model: fb.model,
        api_key: fb.api_key,
      }, messages);
    }

    throw err;
  }
}
