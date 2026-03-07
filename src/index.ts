/**
 * mushi — Perception-first agent framework
 *
 * Two-layer architecture:
 *   Layer 1 (Sense): Fast 5s perception loop. Hash diff, no LLM. <1ms per scan.
 *   Layer 2 (Think): LLM call only when perception triggers. ~10s per think.
 *
 * The slime mold model: tentacles sense constantly (cheap),
 * chemical signals fire only when food/obstacle detected (expensive).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

import type { AgentConfig, PerceptionSignal, Message } from './types.js';
import { parseInterval, estimateTokens, truncateToTokens, log, escalateToKuro as sendToKuro } from './utils.js';
import { perceive, runPlugin } from './perception.js';
import { callModel } from './model.js';
import { parseTags, dispatch, initDedupState, saveDedupState } from './dispatcher.js';
import { startServer } from './server.js';
import { startRoomWatcher } from './room-watcher.js';

// ─── State ──────────────────────────────────────────────

let agentDir = process.cwd();
let config: AgentConfig;
const perceptionCache = new Map<string, PerceptionSignal>();
const conversationHistory: Message[] = [];
let startTime = Date.now();
let senseCount = 0;
let thinkCount = 0;
let wakeResolve: (() => void) | null = null;
let forcePerceive = false;
let lastThinkAt = 0;
let lastKuroStatus = '';
let escalationCount = 0;

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
  forcePerceive = true;
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
  saveDedupState();
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
  type: 'think';
  think: number;
  sense: number;
  ts: string;
  model: string;
  durationMs: number;
  modelLatencyMs: number;
  contextTokens: number;
  perceptionTotal: number;
  perceptionChanged: number;
  actions: Record<string, number>;
  memoryEntries: number;
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

// ─── Layer 2: Think (LLM call) ──────────────────────────

async function think(num: number, signals: PerceptionSignal[]): Promise<void> {
  const thinkStart = Date.now();
  const changedCount = signals.filter(s => s.changed).length;

  log(agentDir, 'think', `think #${num} start (sense #${senseCount})`);

  const context = composeContext(signals);
  const contextTokens = estimateTokens(context);

  const prompt = [
    `Think #${num} | Sense #${senseCount} | ${new Date().toISOString()}`,
    changedCount > 0
      ? `⚡ ${changedCount} signal(s) changed.`
      : '— No perception changes.',
    '',
    'TASK: Analyze each perception signal. Write a brief observation.',
    '',
    'For each signal, answer:',
    '1. What is the current state? (one sentence)',
    '2. Anything unusual or noteworthy? (yes/no + why)',
    '',
    'Then decide ONE action (pick the FIRST that applies):',
    '- Kuro offline or has errors → escalate. Example:',
    '  <agent:escalate>Kuro offline for 5 minutes, last seen at 10:30</agent:escalate>',
    '- Notable pattern → remember it. Example:',
    '  <agent:remember>3 timeout errors in last hour, all from Claude CLI</agent:remember>',
    '- New commits or file changes → log it. Example:',
    '  <agent:action>2 new commits: refactored dispatcher.ts, added tests</agent:action>',
    '- Inbox has a message → read it and respond or escalate',
    '- Nothing notable → just write observations, NO tags',
    '',
    'CRITICAL: Replace example text with YOUR OWN observation. Never copy examples verbatim.',
    '',
    'RULES:',
    '- Be specific. "3 commits in 1h" not "some activity".',
    '- Never escalate "no changes" — silence = no change.',
    '- Do NOT repeat previous observations. Say something new or say nothing.',
    '- Keep response under 200 words.',
  ].join('\n');

  const modelStart = Date.now();
  let response: string;
  try {
    response = await callModel(config.model, agentDir, context, prompt);
  } catch (err) {
    log(agentDir, 'error', `model call failed: ${err instanceof Error ? err.message : 'unknown'}`);
    return;
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
  dispatch(actions, config, agentDir);
  saveDedupState(); // persist after each think cycle

  if (actions.length === 0 && response.trim()) {
    log(agentDir, 'response', response.trim().slice(0, 200));
  }

  cleanInbox();
  persistConversations();

  const actionCounts: Record<string, number> = {};
  for (const a of actions) {
    actionCounts[a.tag] = (actionCounts[a.tag] ?? 0) + 1;
  }

  writeMetrics({
    type: 'think',
    think: num,
    sense: senseCount,
    ts: new Date().toISOString(),
    model: config.model.model,
    durationMs: Date.now() - thinkStart,
    modelLatencyMs,
    contextTokens,
    perceptionTotal: signals.length,
    perceptionChanged: changedCount,
    actions: actionCounts,
    memoryEntries: countMemoryEntries(),
    responseLength: response.length,
  });

  lastThinkAt = Date.now();
  log(agentDir, 'think', `think #${num} end (${actions.length} actions, model ${modelLatencyMs}ms, ctx ~${contextTokens}tok)`);
}

// ─── Auto-Escalation (system-level, no LLM needed) ──────

function escalateToKuro(text: string): void {
  const fullText = `[mushi] ${text}`;
  log(agentDir, 'auto-escalate', fullText);
  escalationCount++;
  sendToKuro(fullText, agentDir);
}

const autoEscalateDedup = new Map<string, number>(); // message → timestamp
const AUTO_ESCALATE_DEDUP_WINDOW = 60 * 60 * 1000; // 1 hour

function checkAutoEscalate(signals: PerceptionSignal[]): void {
  const kuro = signals.find(s => s.name === 'kuro-watcher');
  if (!kuro) return;

  // Extract Kuro status
  const statusMatch = kuro.content.match(/STATUS: (\w+)/);
  const status = statusMatch?.[1] ?? 'unknown';

  // Escalate on status transition (skip first read)
  if (lastKuroStatus && lastKuroStatus !== status) {
    const msg = `Kuro status changed: ${lastKuroStatus} → ${status}`;
    const now = Date.now();
    const lastSent = autoEscalateDedup.get(msg);
    if (!lastSent || now - lastSent >= AUTO_ESCALATE_DEDUP_WINDOW) {
      escalateToKuro(msg);
      autoEscalateDedup.set(msg, now);
      // Clean old entries
      for (const [k, v] of autoEscalateDedup) {
        if (now - v > AUTO_ESCALATE_DEDUP_WINDOW) autoEscalateDedup.delete(k);
      }
    } else {
      log(agentDir, 'auto-escalate', `filtered (dedup, ${Math.round((now - lastSent) / 60000)}min ago): ${msg}`);
    }
  }
  lastKuroStatus = status;
}

// ─── Main: Two-Layer Loop ───────────────────────────────

async function main(): Promise<void> {
  const configPath = process.argv[2] ?? 'agent.yaml';
  agentDir = resolve(process.cwd());
  startTime = Date.now();

  console.log('mushi v0.2.0 — two-layer architecture');
  console.log(`config: ${configPath}`);

  config = loadConfig(resolve(agentDir, configPath));
  console.log(`agent: ${config.name}`);
  console.log(`model: ${config.model.provider}/${config.model.model}`);
  console.log(`context: ${config.model.context_size} tokens`);

  loadConversations();
  initDedupState(agentDir);

  const port = config.server?.port ?? 3000;
  startServer(port, {
    config,
    agentDir,
    startTime,
    getSenseCount: () => senseCount,
    getThinkCount: () => thinkCount,
    getLastThinkAt: () => lastThinkAt,
    getEscalationCount: () => escalationCount,
    getPerceptionCache: () => perceptionCache,
    getConversationHistory: () => conversationHistory,
    wakeLoop,
  });
  // Start room watcher (discussion accelerator)
  startRoomWatcher(config.model, agentDir);
  console.log('room-watcher: monitoring Chat Room SSE');
  console.log();

  const senseInterval = config.loop.sense_interval
    ? parseInterval(config.loop.sense_interval)
    : 5000;

  log(agentDir, 'loop', `two-layer: sense every ${senseInterval}ms, think only on trigger`);

  while (true) {
    senseCount++;

    // Force re-run trigger plugins when woken by inbox/API
    if (forcePerceive) {
      for (const plugin of config.perception) {
        if (plugin.trigger) perceptionCache.delete(plugin.name);
      }
      forcePerceive = false;
    }

    // Layer 1: Sense (fast, no LLM)
    const signals = perceive(config.perception, agentDir, perceptionCache);
    checkAutoEscalate(signals);
    const triggerSignals = signals.filter(s => s.changed && s.trigger);
    const hasRealSignal = triggerSignals.some(s => s.signalStrength === 'signal');

    // Think cooldown: don't re-think within 30s of last think
    // Prevents self-triggered loops (mushi writes MEMORY.md → dev-watcher detects → think → repeat)
    const thinkCooldown = 30_000;
    const cooledDown = lastThinkAt === 0 || (Date.now() - lastThinkAt) >= thinkCooldown;

    // Bootstrap: first scan always thinks
    const shouldThink = senseCount === 1 || (triggerSignals.length > 0 && hasRealSignal && cooledDown);

    if (!shouldThink) {
      // Log every ~60s (12 scans at 5s interval)
      if (senseCount % 12 === 0) {
        log(agentDir, 'sense', `#${senseCount} scans, ${thinkCount} thinks — quiet`);
      }
      await sleep(senseInterval);
      continue;
    }

    // Layer 2: Think (LLM call, only when perception triggered)
    thinkCount++;
    const triggers = triggerSignals.map(s => s.name).join(',');
    log(agentDir, 'sense', `#${senseCount} → think #${thinkCount} (triggers: ${triggers || 'bootstrap'})`);

    await think(thinkCount, signals);

    // Settle: re-run trigger plugins to establish post-think baseline.
    // Purpose: absorb self-caused changes (e.g., think wrote MEMORY.md).
    // After settle, the cached state IS the baseline — force changed=false.
    for (const plugin of config.perception) {
      if (plugin.trigger) {
        const cached = perceptionCache.get(plugin.name);
        if (cached) cached.lastRun = 0; // force re-run
        runPlugin(plugin, agentDir, perceptionCache);
        // Force baseline: settle absorbs the current state as "unchanged"
        const settled = perceptionCache.get(plugin.name);
        if (settled) {
          settled.changed = false;
          settled.signalStrength = 'noise';
        }
      }
    }

    await sleep(senseInterval);
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
