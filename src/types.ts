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
}

export interface LoopConfig {
  interval: string;
  min_interval: string;
  max_interval: string;
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

export interface PerceptionSignal {
  name: string;
  category: string;
  content: string;
  hash: string;
  changed: boolean;
  trigger: boolean;          // propagated from plugin config
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
