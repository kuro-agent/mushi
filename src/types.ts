/**
 * mushi — shared types
 */

export interface AgentConfig {
  name: string;
  soul: string;
  model: ModelConfig;
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
  context_size: number;
  fallback?: {
    provider: string;
    base_url: string;
    model: string;
  };
}

export interface LoopConfig {
  sense_interval?: string;   // fast perception poll (default: 5s)
  interval: string;          // legacy (unused in two-layer mode)
  min_interval: string;      // legacy
  max_interval: string;      // legacy
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
  buffer: number;
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
