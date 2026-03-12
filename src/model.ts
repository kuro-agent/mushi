/**
 * mushi — model interface (OpenAI-compatible + Ollama + Taalas HC1)
 *
 * All model calls go through a priority queue (ModelQueue) to serialize
 * access to the single-GPU oMLX backend. Higher-priority requests
 * (e.g. DM triage) preempt lower-priority ones (e.g. internal think).
 *
 * Interface is designed for future distributed backends — swap
 * LocalModelQueue for DistributedModelQueue without changing callers.
 */

import type { Message, ModelConfig } from './types.js';
import { estimateTokens, log } from './utils.js';

// ─── Priority Levels ─────────────────────────────────────

/** Lower number = higher priority */
export const ModelPriority = {
  INTERACTIVE: 0,   // DM triage, instant reply (human waiting)
  DECISION: 1,      // classify, route, consensus (cycle-critical)
  BACKGROUND: 2,    // dedup, continuation, internal think
} as const;

// ─── Model Queue Interface ───────────────────────────────

export interface QueueStats {
  pending: number;
  active: boolean;
  totalProcessed: number;
}

export interface ModelQueue {
  enqueue<T>(fn: () => Promise<T>, priority: number, label?: string): Promise<T>;
  /** Try to enqueue — returns null immediately if queue is busy. For non-critical calls that can be skipped. */
  tryEnqueue<T>(fn: () => Promise<T>, priority: number, label?: string): Promise<T> | null;
  stats(): QueueStats;
}

// ─── Local Priority Queue (in-process semaphore) ─────────

interface QueueEntry {
  fn: () => Promise<unknown>;
  priority: number;
  label: string;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  enqueuedAt: number;
}

class LocalModelQueue implements ModelQueue {
  private queue: QueueEntry[] = [];
  private processing = false;
  private totalProcessed = 0;
  private logFn: ((tag: string, msg: string) => void) | null = null;

  setLogger(fn: (tag: string, msg: string) => void): void {
    this.logFn = fn;
  }

  async enqueue<T>(fn: () => Promise<T>, priority: number, label = ''): Promise<T> {
    // If nothing is processing and queue is empty, skip queue overhead
    if (!this.processing && this.queue.length === 0) {
      this.processing = true;
      try {
        const result = await fn();
        this.totalProcessed++;
        return result;
      } catch (err) {
        throw err;
      } finally {
        this.processing = false;
        this.drain();  // process any requests that arrived while we were busy
      }
    }

    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        fn, priority, label,
        resolve: resolve as (v: unknown) => void,
        reject,
        enqueuedAt: Date.now(),
      });
      // Re-sort by priority on every insert (small array, negligible cost)
      this.queue.sort((a, b) => a.priority - b.priority);
      if (this.logFn) {
        this.logFn('queue', `+${label} (pending: ${this.queue.length}, p${priority})`);
      }
    });
  }

  tryEnqueue<T>(fn: () => Promise<T>, priority: number, label = ''): Promise<T> | null {
    if (this.processing || this.queue.length > 0) {
      if (this.logFn) {
        this.logFn('queue', `~${label} skipped (busy, pending: ${this.queue.length})`);
      }
      return null;
    }
    return this.enqueue(fn, priority, label);
  }

  stats(): QueueStats {
    return {
      pending: this.queue.length,
      active: this.processing,
      totalProcessed: this.totalProcessed,
    };
  }

  private async drain(): Promise<void> {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;

    while (this.queue.length > 0) {
      const entry = this.queue.shift()!;
      const waitMs = Date.now() - entry.enqueuedAt;
      if (this.logFn && waitMs > 50) {
        this.logFn('queue', `>${entry.label} (waited ${waitMs}ms, p${entry.priority})`);
      }
      try {
        const result = await entry.fn();
        entry.resolve(result);
      } catch (err) {
        entry.reject(err);
      }
      this.totalProcessed++;
    }

    this.processing = false;
  }
}

export const modelQueue: ModelQueue = new LocalModelQueue();

/** Wire up logger once agentDir is known */
export function initModelQueue(agentDir: string): void {
  (modelQueue as LocalModelQueue).setLogger((tag, msg) => log(agentDir, tag, msg));
}

// ─── Provider Config & Call ──────────────────────────────

interface ProviderConfig {
  provider: string;
  base_url: string;
  model: string;
  api_key?: string;
  chat_template_kwargs?: Record<string, unknown>;
  max_tokens?: number;
}

async function callProvider(
  prov: ProviderConfig,
  messages: Message[],
  timeoutMs = 30_000,
): Promise<string> {
  const { provider, base_url, model, api_key, chat_template_kwargs, max_tokens } = prov;

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
    body = {
      model,
      messages,
      stream: false,
      ...(max_tokens ? { max_tokens } : {}),
      ...(chat_template_kwargs ? { chat_template_kwargs } : {}),
    };
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(api_key ? { Authorization: `Bearer ${api_key}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
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

// ─── Public API ──────────────────────────────────────────

/**
 * Call model with explicit thinking toggle.
 * Used by endpoints where reasoning quality matters (classify, route, DM triage).
 */
export async function callModelWithThinking(
  modelConfig: ModelConfig,
  agentDir: string,
  context: string,
  prompt: string,
  enableThinking: boolean,
  priority: number = ModelPriority.DECISION,
): Promise<string> {
  const messages: Message[] = [
    { role: 'system', content: context },
    { role: 'user', content: prompt },
  ];

  const thinkMaxTokens = enableThinking ? (modelConfig.think_max_tokens ?? 1024) : undefined;
  const timeout = enableThinking ? (modelConfig.think_timeout ?? 600_000) : 30_000;

  const primary: ProviderConfig = {
    provider: modelConfig.provider,
    base_url: modelConfig.base_url,
    model: modelConfig.model,
    api_key: modelConfig.api_key,
    max_tokens: thinkMaxTokens,
    chat_template_kwargs: {
      ...modelConfig.chat_template_kwargs,
      enable_thinking: enableThinking,
    },
  };

  const mode = enableThinking ? 'think' : 'fast';
  const label = `${mode}:${primary.model}`;

  return modelQueue.enqueue(async () => {
    log(agentDir, 'model', `calling ${primary.provider}/${primary.model} [${mode}] (context: ~${estimateTokens(context)} tokens${thinkMaxTokens ? `, max: ${thinkMaxTokens}` : ''})`);

    try {
      return await callProvider(primary, messages, timeout);
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
          max_tokens: thinkMaxTokens,
          chat_template_kwargs: {
            ...fb.chat_template_kwargs,
            enable_thinking: enableThinking,
          },
        }, messages, timeout);
      }

      throw err;
    }
  }, priority, label);
}

export async function callModel(
  modelConfig: ModelConfig,
  agentDir: string,
  context: string,
  prompt: string,
  priority: number = ModelPriority.BACKGROUND,
  skipIfBusy = false,
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
    max_tokens: 512,
  };

  const label = `fast:${primary.model}`;

  const doCall = async () => {
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
          chat_template_kwargs: fb.chat_template_kwargs,
        }, messages);
      }

      throw err;
    }
  };

  if (skipIfBusy) {
    const result = modelQueue.tryEnqueue(doCall, priority, label);
    if (result === null) {
      log(agentDir, 'model', `skipped ${label} (queue busy)`);
      return '';
    }
    return result;
  }

  return modelQueue.enqueue(doCall, priority, label);
}
