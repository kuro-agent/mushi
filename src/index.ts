/**
 * mushi — Perception-first agent framework
 *
 * Core thesis: Constraints generate capability.
 * Small context windows force radical prioritization,
 * which produces more structured, useful behavior.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

// ─── Types ───────────────────────────────────────────────

interface AgentConfig {
  name: string;
  soul: string;
  model: ModelConfig;
  loop: LoopConfig;
  perception: PerceptionPlugin[];
  context: ContextBudget;
  memory: { dir: string };
  server?: { port: number };
}

interface ModelConfig {
  provider: string;
  base_url: string;
  model: string;
  context_size: number;
}

interface LoopConfig {
  interval: string;
  min_interval: string;
  max_interval: string;
}

interface PerceptionPlugin {
  name: string;
  script: string;
  interval: string;
  category: string;
}

interface ContextBudget {
  identity: number;
  perception: number;
  memory: number;
  conversation: number;
  buffer: number;
}

interface PerceptionSignal {
  name: string;
  category: string;
  content: string;
  hash: string;
  changed: boolean;
  lastRun: number;
}

interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// ─── Utilities ───────────────────────────────────────────

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + ch;
    hash |= 0;
  }
  return hash.toString(36);
}

function parseInterval(s: string): number {
  const match = s.match(/^(\d+)(s|m|h)$/);
  if (!match) return 60_000;
  const [, num, unit] = match;
  const n = parseInt(num!);
  if (unit === 's') return n * 1_000;
  if (unit === 'm') return n * 60_000;
  return n * 3_600_000;
}

function log(tag: string, msg: string): void {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${tag}] ${msg}`;
  console.log(line);
  try {
    const logDir = join(agentDir, 'logs');
    if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
    writeFileSync(join(logDir, 'behavior.log'), line + '\n', { flag: 'a' });
  } catch { /* fire and forget */ }
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

// ─── Globals ─────────────────────────────────────────────

let agentDir = process.cwd();
let config: AgentConfig;
const perceptionCache = new Map<string, PerceptionSignal>();
const conversationHistory: Message[] = [];
let startTime = Date.now();
let cycleCount = 0;
let wakeResolve: (() => void) | null = null;

// ─── Config ──────────────────────────────────────────────

function loadConfig(configPath: string): AgentConfig {
  const raw = readFileSync(configPath, 'utf-8');
  return parseYaml(raw) as AgentConfig;
}

// ─── Perception ──────────────────────────────────────────

function runPlugin(plugin: PerceptionPlugin): PerceptionSignal {
  const cached = perceptionCache.get(plugin.name);
  const now = Date.now();
  const interval = parseInterval(plugin.interval);

  if (cached && (now - cached.lastRun) < interval) {
    return cached;
  }

  let content = '';
  try {
    const scriptPath = resolve(agentDir, plugin.script);
    content = execSync(`bash "${scriptPath}"`, {
      timeout: 10_000,
      cwd: agentDir,
      encoding: 'utf-8',
    }).trim();
  } catch (err) {
    content = `[error] ${plugin.name}: ${err instanceof Error ? err.message : 'unknown'}`;
    log('perception', `plugin ${plugin.name} failed`);
  }

  const hash = simpleHash(content);
  const changed = !cached || cached.hash !== hash;

  const signal: PerceptionSignal = {
    name: plugin.name,
    category: plugin.category,
    content,
    hash,
    changed,
    lastRun: now,
  };

  perceptionCache.set(plugin.name, signal);
  return signal;
}

function perceive(): PerceptionSignal[] {
  return config.perception.map(p => runPlugin(p));
}

// ─── Context Composer ────────────────────────────────────

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

function truncateToTokens(text: string, maxTokens: number): string {
  const estimated = estimateTokens(text);
  if (estimated <= maxTokens) return text;
  const ratio = maxTokens / estimated;
  return text.slice(0, Math.floor(text.length * ratio)) + '\n...(truncated)';
}

// ─── Model Interface ─────────────────────────────────────

async function callModel(context: string, prompt: string): Promise<string> {
  const messages: Message[] = [
    { role: 'system', content: context },
    { role: 'user', content: prompt },
  ];

  const { provider, base_url, model } = config.model;

  let url: string;
  let body: Record<string, unknown>;

  if (provider === 'ollama') {
    url = `${base_url}/api/chat`;
    body = { model, messages, stream: false };
  } else {
    url = `${base_url}/v1/chat/completions`;
    body = { model, messages, stream: false };
  }

  log('model', `calling ${provider}/${model} (context: ~${estimateTokens(context)} tokens)`);

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

// ─── Action Dispatcher ───────────────────────────────────

interface ParsedAction {
  tag: string;
  content: string;
  attrs: Record<string, string>;
}

function parseTags(response: string): ParsedAction[] {
  const actions: ParsedAction[] = [];
  const regex = /<agent:(\w+)([^>]*)>([\s\S]*?)<\/agent:\1>/g;

  let match;
  while ((match = regex.exec(response)) !== null) {
    const [, tag, attrStr, content] = match;
    const attrs: Record<string, string> = {};
    const attrRegex = /(\w+)="([^"]*)"/g;
    let attrMatch;
    while ((attrMatch = attrRegex.exec(attrStr!)) !== null) {
      attrs[attrMatch[1]!] = attrMatch[2]!;
    }
    actions.push({ tag: tag!, content: content!.trim(), attrs });
  }

  const selfClosing = /<agent:(\w+)([^/]*?)\/>/g;
  while ((match = selfClosing.exec(response)) !== null) {
    const [, tag, attrStr] = match;
    const attrs: Record<string, string> = {};
    const attrRegex = /(\w+)="([^"]*)"/g;
    let attrMatch;
    while ((attrMatch = attrRegex.exec(attrStr!)) !== null) {
      attrs[attrMatch[1]!] = attrMatch[2]!;
    }
    actions.push({ tag: tag!, content: '', attrs });
  }

  return actions;
}

function dispatch(actions: ParsedAction[]): { nextInterval?: number } {
  let nextInterval: number | undefined;

  for (const action of actions) {
    switch (action.tag) {
      case 'action':
        log('action', action.content);
        break;

      case 'remember': {
        const memDir = resolve(agentDir, config.memory.dir);
        const topic = action.attrs.topic;
        const targetFile = topic
          ? join(memDir, 'topics', `${topic}.md`)
          : join(memDir, 'MEMORY.md');

        const dir = topic ? join(memDir, 'topics') : memDir;
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

        writeFileSync(targetFile, '\n- ' + action.content + '\n', { flag: 'a' });
        log('memory', `saved to ${topic ?? 'MEMORY.md'}`);
        break;
      }

      case 'chat':
        log('chat', action.content);
        console.log(`\n💬 ${config.name}: ${action.content}\n`);
        break;

      case 'schedule': {
        const next = action.attrs.next;
        if (next) {
          nextInterval = parseInterval(next);
          log('schedule', `next cycle in ${next} (${action.attrs.reason ?? 'no reason'})`);
        }
        break;
      }

      default:
        log('dispatch', `unknown tag: agent:${action.tag}`);
    }
  }

  return { nextInterval };
}

// ─── HTTP Server ─────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function respond(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function startServer(port: number): void {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);

    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      respond(res, 200, {
        ok: true,
        name: config.name,
        uptime: Math.floor((Date.now() - startTime) / 1000),
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/status') {
      respond(res, 200, {
        name: config.name,
        uptime: Math.floor((Date.now() - startTime) / 1000),
        cycles: cycleCount,
        perception: {
          plugins: config.perception.length,
          cached: perceptionCache.size,
          signals: [...perceptionCache.values()].map(s => ({
            name: s.name,
            category: s.category,
            changed: s.changed,
            lastRun: new Date(s.lastRun).toISOString(),
          })),
        },
        loop: { interval: config.loop.interval },
        conversation: { messages: conversationHistory.length },
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/perception') {
      respond(res, 200, {
        signals: [...perceptionCache.values()].map(s => ({
          name: s.name,
          category: s.category,
          changed: s.changed,
          content: s.content,
          lastRun: new Date(s.lastRun).toISOString(),
        })),
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/inbox') {
      try {
        const body = await readBody(req);
        const { from, text } = JSON.parse(body) as { from?: string; text?: string };
        if (!text) {
          respond(res, 400, { error: 'text is required' });
          return;
        }

        const inboxDir = join(agentDir, 'inbox');
        if (!existsSync(inboxDir)) mkdirSync(inboxDir, { recursive: true });

        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const ts = new Date().toISOString();
        writeFileSync(
          join(inboxDir, `${id}.json`),
          JSON.stringify({ id, from: from ?? 'user', text, ts }, null, 2),
        );
        log('inbox', `message from ${from ?? 'user'}: ${text.slice(0, 80)}`);

        wakeLoop();
        respond(res, 200, { ok: true, id });
      } catch {
        respond(res, 400, { error: 'invalid JSON — expected { "text": "...", "from": "..." }' });
      }
      return;
    }

    respond(res, 404, { error: 'not found' });
  });

  server.listen(port, () => {
    log('server', `listening on http://localhost:${port}`);
  });
}

// ─── Wake Mechanism ──────────────────────────────────────

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

// ─── Graceful Shutdown ──────────────────────────────────

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
    log('init', `restored ${conversationHistory.length} conversation messages`);
  } catch { /* start fresh */ }
}

function shutdown(signal: string): void {
  log('shutdown', `received ${signal}`);
  persistConversations();
  log('shutdown', `saved ${conversationHistory.length} messages — goodbye`);
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ─── Inbox Cleanup ───────────────────────────────────────

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

// ─── OODA Loop ───────────────────────────────────────────

async function cycle(num: number): Promise<number | undefined> {
  log('loop', `cycle #${num} start`);

  const signals = perceive();
  const changedCount = signals.filter(s => s.changed).length;
  log('perceive', `${signals.length} plugins, ${changedCount} changed`);

  const context = composeContext(signals);

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

  let response: string;
  try {
    response = await callModel(context, prompt);
  } catch (err) {
    log('error', `model call failed: ${err instanceof Error ? err.message : 'unknown'}`);
    return undefined;
  }

  conversationHistory.push(
    { role: 'user', content: prompt },
    { role: 'assistant', content: response },
  );
  while (conversationHistory.length > 40) {
    conversationHistory.shift();
  }

  const actions = parseTags(response);
  const { nextInterval } = dispatch(actions);

  if (actions.length === 0 && response.trim()) {
    log('response', response.trim().slice(0, 200));
  }

  cleanInbox();
  persistConversations();
  log('loop', `cycle #${num} end (${actions.length} actions)`);
  return nextInterval;
}

// ─── Main ────────────────────────────────────────────────

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
  startServer(port);
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

    log('loop', `sleeping ${Math.round(interval / 1000)}s`);
    await sleep(interval);
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
