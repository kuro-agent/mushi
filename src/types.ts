/**
 * mushi — shared types
 */

export interface AgentConfig {
  name: string;
  soul: string;
  model: ModelConfig;
  triage_model?: ModelConfig;
  loop: LoopConfig;
  perception: PerceptionPlugin[];
  context: ContextBudget;
  memory: { dir: string };
  server?: { port: number };
}

export interface ModelConfig {
  provider: string;
  base_url: string;
  model: string;
  api_key?: string;
  chat_template_kwargs?: Record<string, unknown>;
  context_size: number;
  think_max_tokens?: number;   // max completion tokens for think mode (default: 1024)
  think_timeout?: number;      // timeout ms for think mode (default: 600000)
  max_tokens?: number;         // max response tokens for non-think mode (default: 512)
  // Sampling parameters (Qwen3.5 official recommendations)
  temperature?: number;        // default: 1.0
  top_p?: number;              // default: 1.0 (non-think) / 0.95 (think)
  top_k?: number;              // default: 20
  presence_penalty?: number;   // default: 2.0 (non-think) / 1.5 (think)
  fallback?: {
    provider: string;
    base_url: string;
    model: string;
    api_key?: string;
    chat_template_kwargs?: Record<string, unknown>;
  };
}

export interface LoopConfig {
  sense_interval?: string;   // fast perception poll (default: 5s)
}

export interface PerceptionPlugin {
  name: string;
  script: string;
  interval: string;
  category: string;
  trigger?: boolean;         // can this plugin wake the LLM? default: false
  strip_pattern?: string;    // regex to strip before hashing (noise reduction)
}

export interface ContextBudget {
  identity: number;
  perception: number;
  memory: number;
  conversation: number;
}

export type SignalStrength = 'noise' | 'low' | 'signal';

export interface PerceptionSignal {
  name: string;
  category: string;
  content: string;
  hash: string;
  changed: boolean;
  trigger: boolean;          // propagated from plugin config
  signalStrength: SignalStrength;  // classified change type (noise/low/signal)
  lastRun: number;
}

export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ParsedAction {
  tag: string;
  content: string;
  attrs: Record<string, string>;
}

// --- Generic Triage API (mushi independence) ---

/** Standard event types that any agent can use */
export type TriageEventType = 'timer' | 'message' | 'change' | 'alert' | 'scheduled' | 'startup' | 'custom';

/** Generic triage request — the new primary format */
export interface TriageRequest {
  event: TriageEventType;
  source?: string;
  priority_hint?: 'high' | 'normal' | 'low';
  context?: Record<string, unknown>;
  rules?: TriageRule[];
}

/** Legacy triage request — mini-agent format, still supported */
export interface LegacyTriageRequest {
  trigger: string;
  source?: string;
  metadata?: Record<string, unknown>;
}

/** Configurable triage rule */
export interface TriageRule {
  match: Record<string, unknown>;
  action: 'wake' | 'skip' | 'quick';
  reason: string;
}

/** Unified triage response */
export interface TriageResponse {
  ok: true;
  action: 'wake' | 'skip' | 'quick' | 'instant';
  reason: string;
  latencyMs: number;
  method: 'rule' | 'llm' | 'error';
}
