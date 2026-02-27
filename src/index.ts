/**
 * mushi — Perception-first agent framework
 *
 * Core thesis: Constraints generate capability.
 * Small context windows force radical prioritization,
 * which produces more structured, useful behavior.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

import type { AgentConfig, PerceptionSignal, Message } from './types.js';
import { parseInterval, estimateTokens, truncateToTokens, log } from './utils.js';
import { perceive } from './perception.js';
import { callModel } from './model.js';
import { parseTags, dispatch } from './dispatcher.js';
import { startServer } from './server.js';

// ─── State ──────────────────────────────────────────────

let agentDir = process.cwd();
let config: AgentConfig;
const perceptionCache = new Map<string, PerceptionSignal>();
const conversationHistory: Message[] = [];
let startTime = Date.now();
let cycleCount = 0;
let wakeResolve: (() => void) | null = null;

// ─── Config ─────────────────────────────────────────────

function loadConfig(configPath: string): AgentConfig {
  const raw = readFileSync(configPath, 'utf-8');
  return parseYaml(raw) as AgentConfig;
}

// ─── Context Composer ───────────────────────────────────

function composeContext(signals: PerceptionSignal[]): string {
  const totalBudget = config.model.context_size;
  const responseBudget = Math.floor(totalBudget * 0.2);
  const available = totalBudget - responseBudget;

  const soulPath = resolve(agentDir, config.soul);
  const soul = existsSync(soulPath) ? readFileSync(soulPath, 'utf-8') : '(no identity defined)';
  const soulBudget = Math.floor(available * config.context.identity / 100);
  const soulText = truncateToTokens(soul, soulBudget);

  const percBudget = Math.floor(available * config.context.perception / 100);
  const changedSignals = signals.filter(s => s.changed);
  const stableSignals = signals.filter(s => !s.changed);
  const orderedSignals = [...changedSignals, ...stableSignals];

  let percText = '';
  let percTokens = 0;
  for (const signal of orderedSignals) {
    const section = `<${signal.name}${signal.changed ? '' : ' unchanged="true"'}>\n${signal.content}\n</${signal.name}>\n`;
    const sectionTokens = estimateTokens(section);
    if (percTokens + sectionTokens > percBudget) break;
    percText += section;
    percTokens += sectionTokens;
  }

  const memBudget = Math.floor(available * config.context.memory / 100);
  const memPath = join(resolve(agentDir, config.memory.dir), 'MEMORY.md');
  const memRaw = existsSync(memPath) ? readFileSync(memPath, 'utf-8') : '';
  const memText = truncateToTokens(memRaw, memBudget);

  const convBudget = Math.floor(available * config.context.conversation / 100);
  let convText = '';
  let convTokens = 0;
  for (let i = conversationHistory.length - 1; i >= 0; i--) {
    const msg = conversationHistory[i]!;
    const line = `${msg.role}: ${msg.content}\n`;
    const lineTokens = estimateTokens(line);
    if (convTokens + lineTokens > convBudget) break;
    convText = line + convText;
    convTokens += lineTokens;
  }

  return [
    '<identity>\n' + soulText + '\n</identity>',
    '<perception>\n' + percText + '</perception>',
    memText ? '<memory>\n' + memText + '\n</memory>' : '',
    convText ? '<conversation>\n' + convText + '</conversation>' : '',
  ].filter(Boolean).join('\n\n');
}

// ─── Wake / Sleep ───────────────────────────────────────

function wakeLoop(): void {
  if (wakeResolve) {
    wakeResolve();
    wakeResolve = null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => {
    const timer = setTimeout(r, ms);
    wakeResolve = () => {
      clearTimeout(timer);
      r();
    };
  });
}

// ─── Conversation Persistence ───────────────────────────

function persistConversations(): void {
  const convPath = join(resolve(agentDir, config.memory.dir), 'conversations.jsonl');
  try {
    const lines = conversationHistory.map(m => JSON.stringify(m)).join('\n');
    writeFileSync(convPath, lines + '\n');
  } catch { /* best effort */ }
}

function loadConversations(): void {
  const convPath = join(resolve(agentDir, config.memory.dir), 'conversations.jsonl');
  if (!existsSync(convPath)) return;
  try {
    const lines = readFileSync(convPath, 'utf-8').trim().split('\n');
    for (const line of lines) {
      if (line) conversationHistory.push(JSON.parse(line) as Message);
    }
    log(agentDir, 'init', `restored ${conversationHistory.length} conversation messages`);
  } catch { /* start fresh */ }
}

// ─── Graceful Shutdown ──────────────────────────────────

function shutdown(signal: string): void {
  log(agentDir, 'shutdown', `received ${signal}`);
  persistConversations();
  log(agentDir, 'shutdown', `saved ${conversationHistory.length} messages — goodbye`);
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ─── Inbox ──────────────────────────────────────────────

function cleanInbox(): void {
  const inboxDir = join(agentDir, 'inbox');
  if (!existsSync(inboxDir)) return;
  try {
    for (const file of readdirSync(inboxDir)) {
      if (file.endsWith('.json') || file.endsWith('.txt') || file.endsWith('.md')) {
        unlinkSync(join(inboxDir, file));
      }
    }
  } catch { /* fire and forget */ }
}

// ─── Metrics ─────────────────────────────────────────────

interface CycleMetrics {
  cycle: number;
  ts: string;
  durationMs: number;
  modelLatencyMs: number;
  contextTokens: number;
  perceptionTotal: number;
  perceptionChanged: number;
  actions: Record<string, number>;
  memoryEntries: number;
  scheduledNext: string | null;
  responseLength: number;
}

function countMemoryEntries(): number {
  const memPath = join(resolve(agentDir, config.memory.dir), 'MEMORY.md');
  if (!existsSync(memPath)) return 0;
  try {
    const content = readFileSync(memPath, 'utf-8');
    return content.split('\n').filter(l => l.startsWith('- ')).length;
  } catch { return 0; }
}

function writeMetrics(metrics: CycleMetrics): void {
  try {
    const metricsDir = join(agentDir, 'logs');
    if (!existsSync(metricsDir)) mkdirSync(metricsDir, { recursive: true });
    writeFileSync(
      join(metricsDir, 'metrics.jsonl'),
      JSON.stringify(metrics) + '\n',
      { flag: 'a' },
    );
  } catch { /* fire and forget */ }
}

// ─── OODA Cycle ─────────────────────────────────────────

async function cycle(num: number): Promise<number | undefined> {
  const cycleStart = Date.now();
  log(agentDir, 'loop', `cycle #${num} start`);

  const signals = perceive(config.perception, agentDir, perceptionCache);
  const changedCount = signals.filter(s => s.changed).length;
  log(agentDir, 'perceive', `${signals.length} plugins, ${changedCount} changed`);

  const context = composeContext(signals);
  const contextTokens = estimateTokens(context);

  const prompt = [
    `You are ${config.name}, an autonomous agent. Cycle #${num}.`,
    `Time: ${new Date().toISOString()}`,
    changedCount > 0
      ? `${changedCount} perception signal(s) changed since last cycle.`
      : 'No perception changes.',
    '',
    'Based on your identity and perception, decide what to do.',
    'Use <agent:action>...</agent:action> to report what you did.',
    'Use <agent:remember>...</agent:remember> to save insights.',
    'Use <agent:chat>...</agent:chat> to speak.',
    'Use <agent:schedule next="Xm" reason="..." /> to set next interval.',
    'If nothing useful to do, say so.',
  ].join('\n');

  const modelStart = Date.now();
  let response: string;
  try {
    response = await callModel(config.model, agentDir, context, prompt);
  } catch (err) {
    log(agentDir, 'error', `model call failed: ${err instanceof Error ? err.message : 'unknown'}`);
    return undefined;
  }
  const modelLatencyMs = Date.now() - modelStart;

  conversationHistory.push(
    { role: 'user', content: prompt },
    { role: 'assistant', content: response },
  );
  while (conversationHistory.length > 40) {
    conversationHistory.shift();
  }

  const actions = parseTags(response);
  const { nextInterval } = dispatch(actions, config, agentDir);

  if (actions.length === 0 && response.trim()) {
    log(agentDir, 'response', response.trim().slice(0, 200));
  }

  cleanInbox();
  persistConversations();

  // ─── Structured Metrics ───
  const actionCounts: Record<string, number> = {};
  for (const a of actions) {
    actionCounts[a.tag] = (actionCounts[a.tag] ?? 0) + 1;
  }
  const scheduledNext = actions.find(a => a.tag === 'schedule')?.attrs.next ?? null;

  writeMetrics({
    cycle: num,
    ts: new Date().toISOString(),
    durationMs: Date.now() - cycleStart,
    modelLatencyMs,
    contextTokens,
    perceptionTotal: signals.length,
    perceptionChanged: changedCount,
    actions: actionCounts,
    memoryEntries: countMemoryEntries(),
    scheduledNext,
    responseLength: response.length,
  });

  log(agentDir, 'loop', `cycle #${num} end (${actions.length} actions, model ${modelLatencyMs}ms, ctx ~${contextTokens}tok)`);
  return nextInterval;
}

// ─── Main ───────────────────────────────────────────────

async function main(): Promise<void> {
  const configPath = process.argv[2] ?? 'agent.yaml';
  agentDir = resolve(process.cwd());
  startTime = Date.now();

  console.log('mushi v0.1.0');
  console.log(`config: ${configPath}`);

  config = loadConfig(resolve(agentDir, configPath));
  console.log(`agent: ${config.name}`);
  console.log(`model: ${config.model.provider}/${config.model.model}`);
  console.log(`context: ${config.model.context_size} tokens`);

  loadConversations();

  const port = config.server?.port ?? 3000;
  startServer(port, {
    config,
    agentDir,
    startTime,
    getCycleCount: () => cycleCount,
    getPerceptionCache: () => perceptionCache,
    getConversationHistory: () => conversationHistory,
    wakeLoop,
  });
  console.log();

  const defaultInterval = parseInterval(config.loop.interval);
  const minInterval = parseInterval(config.loop.min_interval);
  const maxInterval = parseInterval(config.loop.max_interval);

  let interval = defaultInterval;

  while (true) {
    cycleCount++;
    const nextInterval = await cycle(cycleCount);

    if (nextInterval !== undefined) {
      interval = Math.max(minInterval, Math.min(maxInterval, nextInterval));
    } else {
      interval = defaultInterval;
    }

    log(agentDir, 'loop', `sleeping ${Math.round(interval / 1000)}s`);
    await sleep(interval);
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
