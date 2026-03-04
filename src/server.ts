/**
 * mushi — HTTP server (health, status, perception, inbox)
 */

import { existsSync, mkdirSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AgentConfig, PerceptionSignal, Message } from './types.js';
import { log, parseJsonFromLLM } from './utils.js';
import { callModel } from './model.js';
import { getRoomWatcherStatus } from './room-watcher.js';

// =============================================================================
// Trail — Shared Attention History (mushi side)
// =============================================================================

interface TrailEntry {
  ts: string;
  agent: 'kuro' | 'mushi';
  type: 'focus' | 'cite' | 'triage' | 'scout';
  decision?: 'wake' | 'skip' | 'quick';
  topics: string[];
  detail: string;
  decay_h: number;
}

const TRAIL_MAX_ENTRIES = 500;

function getTrailPath(): string {
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  return join(homeDir, '.mini-agent', 'trail.jsonl');
}

function writeTrailEntry(entry: TrailEntry): void {
  try {
    const filePath = getTrailPath();
    const dir = dirname(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(filePath, JSON.stringify(entry) + '\n', 'utf-8');
    // Ring buffer trim
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    if (lines.length > TRAIL_MAX_ENTRIES) {
      writeFileSync(filePath, lines.slice(-TRAIL_MAX_ENTRIES).join('\n') + '\n', 'utf-8');
    }
  } catch { /* fire-and-forget */ }
}

function trailFromTriage(trigger: string, source: string | undefined, action: string, reason: string, method: string): void {
  const decision = (action === 'skip' ? 'skip' : action === 'quick' ? 'quick' : 'wake') as 'skip' | 'quick' | 'wake';
  const topics: string[] = [];
  if (trigger) topics.push(trigger);
  if (source) {
    // Extract meaningful topic from source string
    const clean = source.replace(/\(.*?\)/g, '').trim().toLowerCase();
    if (clean && clean !== trigger) topics.push(clean);
  }
  writeTrailEntry({
    ts: new Date().toISOString(),
    agent: 'mushi',
    type: 'triage',
    decision,
    topics,
    detail: `[${method}] ${reason}`.slice(0, 200),
    decay_h: decision === 'skip' ? 1 : decision === 'quick' ? 2 : 4,
  });
}

const DIRECT_MESSAGE_SOURCES = ['telegram', 'room', 'chat'] as const;

export interface ServerDeps {
  config: AgentConfig;
  agentDir: string;
  startTime: number;
  getSenseCount: () => number;
  getThinkCount: () => number;
  getLastThinkAt: () => number;
  getEscalationCount: () => number;
  getPerceptionCache: () => Map<string, PerceptionSignal>;
  getConversationHistory: () => Message[];
  wakeLoop: () => void;
}

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

export function startServer(port: number, deps: ServerDeps): void {
  const { config, agentDir, startTime } = deps;

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
      const lastThink = deps.getLastThinkAt();
      respond(res, 200, {
        ok: true,
        name: config.name,
        uptime: Math.floor((Date.now() - startTime) / 1000),
        senses: deps.getSenseCount(),
        thinks: deps.getThinkCount(),
        escalations: deps.getEscalationCount(),
        lastThinkAt: lastThink ? new Date(lastThink).toISOString() : null,
        lastThinkAgo: lastThink ? Math.floor((Date.now() - lastThink) / 1000) : null,
        roomWatcher: getRoomWatcherStatus(),
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/status') {
      const cache = deps.getPerceptionCache();
      respond(res, 200, {
        name: config.name,
        uptime: Math.floor((Date.now() - startTime) / 1000),
        senses: deps.getSenseCount(),
        thinks: deps.getThinkCount(),
        perception: {
          plugins: config.perception.length,
          cached: cache.size,
          signals: [...cache.values()].map(s => ({
            name: s.name,
            category: s.category,
            changed: s.changed,
            lastRun: new Date(s.lastRun).toISOString(),
          })),
        },
        conversation: { messages: deps.getConversationHistory().length },
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/perception') {
      const cache = deps.getPerceptionCache();
      respond(res, 200, {
        signals: [...cache.values()].map(s => ({
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
        log(agentDir, 'inbox', `message from ${from ?? 'user'}: ${text.slice(0, 80)}`);

        deps.wakeLoop();
        respond(res, 200, { ok: true, id });
      } catch {
        respond(res, 400, { error: 'invalid JSON — expected { "text": "...", "from": "..." }' });
      }
      return;
    }

    // ─── Trigger Triage ─────────────────────────────────
    if (req.method === 'POST' && url.pathname === '/api/triage') {
      try {
        const body = await readBody(req);
        const { trigger, source, metadata } = JSON.parse(body) as {
          trigger?: string;
          source?: string;
          metadata?: { inboxEmpty?: boolean; lastThinkAgo?: number; hasOverdueTasks?: boolean; messageText?: string };
        };
        if (!trigger) {
          respond(res, 400, { error: 'trigger type is required' });
          return;
        }

        // Hard rules — bypass LLM for obvious cases
        // Use `trigger` (clean keyword like "alert") not `source` (may have extra text like "alert (yielded, waited 264s)")
        const alwaysWake = ['alert', 'mobile', 'startup'];
        if (alwaysWake.includes(trigger)) {
          trailFromTriage(trigger, source, 'wake', `${trigger} always wakes`, 'rule');
          respond(res, 200, { ok: true, action: 'wake', reason: `${trigger} always wakes`, latencyMs: 0, method: 'rule' });
          return;
        }

        // Cron optimization — skip redundant HEARTBEAT checks when Kuro recently thought
        // HEARTBEAT.md is checked in every OODA cycle, so a cron HEARTBEAT check is redundant
        // if Kuro thought recently. perceptionChanged is too coarse (timestamps always change),
        // so we only check lastThinkAgo with a 25min threshold (cron runs every 30min).
        if (trigger === 'cron' && source && /heartbeat|pending.tasks/i.test(source)) {
          const lastThink = metadata?.lastThinkAgo ?? Infinity;
          if (lastThink < 1500) {
            log(agentDir, 'triage', `0ms — cron/heartbeat → skip (rule: lastThink=${lastThink}s < 25min)`);
            trailFromTriage(trigger, source, 'skip', `cron heartbeat redundant — Kuro thought ${lastThink}s ago`, 'rule');
            respond(res, 200, { ok: true, action: 'skip', reason: `cron heartbeat redundant — Kuro thought ${lastThink}s ago`, latencyMs: 0, method: 'rule' });
            return;
          }
        }

        // Direct message triage — classify as instant (fast /api/ask) or wake (full OODA)
        if ((DIRECT_MESSAGE_SOURCES as readonly string[]).includes(trigger)) {
          // No message text → can't classify, default to wake
          if (!metadata?.messageText) {
            trailFromTriage(trigger, source, 'wake', 'direct message without text — defaulting to wake', 'rule');
            respond(res, 200, { ok: true, action: 'wake', reason: 'direct message without text — defaulting to wake', latencyMs: 0, method: 'rule' });
            return;
          }

          const instantPrompt = [
            'You classify user messages for an AI agent. Decide: can this be answered instantly from memory/status (instant), or does it need deep thinking/action (wake)?',
            '',
            'Respond with JSON only: {"action": "instant" or "wake", "reason": "one line"}',
            '',
            'INSTANT — answer from memory, status, or simple lookup:',
            '- Status queries: "在幹嘛", "what are you doing", "status"',
            '- Simple factual questions answerable from memory',
            '- Greetings, acknowledgements, short reactions',
            '- "OK", "好", "understood" type messages',
            '',
            'WAKE — needs full thinking cycle:',
            '- Requests to DO something (implement, fix, create, deploy)',
            '- Complex questions requiring research or multi-step reasoning',
            '- Messages with URLs to analyze',
            '- Instructions, directives, task assignments',
            '- Questions about external topics needing web lookup',
          ].join('\n');

          const msgInput = `Message: ${metadata.messageText.slice(0, 500)}`;

          const start = Date.now();
          const result = await callModel(config.model, agentDir, instantPrompt, msgInput);
          const latencyMs = Date.now() - start;

          const parsed = parseJsonFromLLM<{ action?: string; reason?: string }>(
            result,
            { action: 'wake', reason: 'parse failed — defaulting to wake' },
          );

          // Validate action — only allow instant or wake
          const action = parsed.action === 'instant' ? 'instant' : 'wake';

          log(agentDir, 'triage', `${latencyMs}ms — DM ${trigger} → ${action}: ${metadata.messageText.slice(0, 80)}`);
          trailFromTriage(trigger, source, action, parsed.reason ?? '', 'llm');
          respond(res, 200, { ok: true, action, reason: parsed.reason ?? '', latencyMs, method: 'llm' });
          return;
        }

        // LLM triage for ambiguous cases (workspace, cron, heartbeat, etc.)
        const triagePrompt = [
          'You classify trigger events for an AI agent into three levels: skip (noise), quick (lightweight check), or wake (full thinking cycle).',
          '',
          'Respond with JSON only: {"action": "skip" or "quick" or "wake", "reason": "one line"}',
          '',
          'Three choices:',
          '- skip: not worth thinking about (noise, repeated, no real change)',
          '- quick: worth checking but doesn\'t need deep analysis (~5K tokens, 5-15s). For status checks, minor perception changes, routine confirmations.',
          '- wake: needs full thinking cycle (~50K tokens, 60-120s). For new tasks, complex decisions, multi-step actions, learning.',
          '',
          'Key metadata fields:',
          '- lastThinkAgo: seconds since last thinking cycle',
          '- lastActionType: "action" (did something), "idle" (no action), "none" (first cycle)',
          '- perceptionChangedCount: number of perception sections that changed since last build',
          '- perceptionChanged: boolean (any change at all)',
          '',
          'Guidelines:',
          '- workspace changes from auto-commit (agent\'s own changes) → skip',
          '- workspace changes from external edits → wake',
          '- cron heartbeat with no overdue tasks → skip',
          '- cron with overdue tasks → quick (check and confirm, rarely needs full cycle)',
          '- cron source scan or learning tasks → wake',
          '- startup/bootstrap → wake',
          '- heartbeat when lastThinkAgo < 300 (5min) AND perceptionChangedCount <= 1 → skip',
          '- heartbeat when lastThinkAgo > 900 (15min) AND perceptionChangedCount <= 2 → quick (enough gap, check status)',
          '- heartbeat when lastThinkAgo > 900 (15min) AND perceptionChangedCount >= 3 → wake (many changes accumulated)',
          '- heartbeat when perceptionChangedCount >= 3 → lean wake (many environment changes)',
          '- heartbeat when lastActionType="idle" AND perceptionChangedCount >= 2 → quick (idle but some change, worth a quick look)',
        ].join('\n');

        const input = [
          `Trigger: ${trigger}`,
          source ? `Source: ${source}` : '',
          metadata ? `Metadata: ${JSON.stringify(metadata)}` : '',
        ].filter(Boolean).join('\n');

        const start = Date.now();
        const result = await callModel(config.model, agentDir, triagePrompt, input);
        const latencyMs = Date.now() - start;

        const parsed = parseJsonFromLLM<{ action?: string; reason?: string }>(
          result,
          { action: 'wake', reason: 'parse failed — defaulting to wake' },
        );

        // Validate action — only allow skip, quick, wake
        const validActions = ['skip', 'quick', 'wake'];
        const action = validActions.includes(parsed.action ?? '') ? parsed.action! : 'wake';

        log(agentDir, 'triage', `${latencyMs}ms — ${trigger}/${source ?? '?'} → ${action}`);
        trailFromTriage(trigger, source, action, parsed.reason ?? '', 'llm');
        respond(res, 200, { ok: true, action, reason: parsed.reason ?? '', latencyMs, method: 'llm' });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown';
        log(agentDir, 'error', `triage failed: ${msg}`);
        // On error, always wake (fail-open)
        // trail not written in catch — trigger/source may not be parsed
        respond(res, 200, { ok: true, action: 'wake', reason: `triage error: ${msg}`, latencyMs: 0, method: 'error' });
      }
      return;
    }

    // ─── Instant Reply — quick first response for direct messages ──────
    if (req.method === 'POST' && url.pathname === '/api/instant-reply') {
      try {
        const body = await readBody(req);
        const { message, context: msgContext, recentMessages } = JSON.parse(body) as {
          message?: string;
          context?: string;
          recentMessages?: Array<{ from: string; text: string }>;
        };
        if (!message) {
          respond(res, 400, { error: 'message is required' });
          return;
        }

        const systemPrompt = [
          'You are Kuro, a personal AI assistant. Generate a quick, natural first response to this message.',
          'Keep it SHORT (1-3 sentences). Be genuine and conversational.',
          'This is a fast acknowledgement — a deeper response will follow if needed.',
          'Reply in the same language as the message. If Chinese, use 繁體中文.',
          'Do NOT use emoji prefixes like 💬 or 🤔.',
          '',
          msgContext ? `Context: ${msgContext.slice(0, 500)}` : '',
          recentMessages?.length
            ? `Recent conversation:\n${recentMessages.slice(-5).map(m => `${m.from}: ${m.text.slice(0, 200)}`).join('\n')}`
            : '',
        ].filter(Boolean).join('\n');

        const start = Date.now();
        const result = await callModel(config.model, agentDir, systemPrompt, `Message from Alex: ${message.slice(0, 500)}`);
        const latencyMs = Date.now() - start;

        const reply = result.trim().slice(0, 500);
        log(agentDir, 'instant-reply', `${latencyMs}ms — "${message.slice(0, 60)}" → "${reply.slice(0, 60)}"`);
        respond(res, 200, { ok: true, reply, latencyMs });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown';
        log(agentDir, 'error', `instant-reply failed: ${msg}`);
        respond(res, 500, { error: msg });
      }
      return;
    }

    // ─── Repetition Detection ──────────────────────────────
    if (req.method === 'POST' && url.pathname === '/api/dedup') {
      try {
        const body = await readBody(req);
        const { text, existing } = JSON.parse(body) as { text?: string; existing?: string[] };
        if (!text) {
          respond(res, 400, { error: 'text is required' });
          return;
        }
        if (!existing || existing.length === 0) {
          respond(res, 200, { ok: true, isDuplicate: false, reason: 'no existing entries', latencyMs: 0 });
          return;
        }

        const dedupPrompt = [
          'You detect duplicate content. Given a NEW entry and EXISTING entries, determine if the new entry is a duplicate or near-duplicate.',
          '',
          'Respond with JSON only: {"isDuplicate": true/false, "matchedIndex": N or -1, "similarity": 0.0-1.0, "reason": "one line"}',
          '',
          'Rules:',
          '- Same insight rephrased = duplicate (similarity > 0.8)',
          '- Same topic but new angle = not duplicate',
          '- Strictly new information = not duplicate',
        ].join('\n');

        const entries = existing.slice(-20).map((e, i) => `[${i}] ${e.slice(0, 200)}`).join('\n');
        const input = `NEW: ${text.slice(0, 300)}\n\nEXISTING:\n${entries}`;

        const start = Date.now();
        const result = await callModel(config.model, agentDir, dedupPrompt, input);
        const latencyMs = Date.now() - start;

        const parsed = parseJsonFromLLM<{ isDuplicate?: boolean; matchedIndex?: number; similarity?: number; reason?: string }>(
          result,
          { isDuplicate: false, reason: 'parse failed — allowing write' },
        );

        const matchedEntry = parsed.matchedIndex != null && parsed.matchedIndex >= 0 && existing[parsed.matchedIndex]
          ? existing[parsed.matchedIndex]!.slice(0, 100)
          : undefined;

        log(agentDir, 'dedup', `${latencyMs}ms — ${parsed.isDuplicate ? 'DUPLICATE' : 'unique'} (${(parsed.similarity ?? 0).toFixed(2)})`);
        respond(res, 200, {
          ok: true,
          isDuplicate: parsed.isDuplicate ?? false,
          similarity: parsed.similarity ?? 0,
          matchedEntry,
          reason: parsed.reason ?? '',
          latencyMs,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown';
        log(agentDir, 'error', `dedup failed: ${msg}`);
        // On error, allow write (fail-open)
        respond(res, 200, { ok: true, isDuplicate: false, reason: `dedup error: ${msg}`, latencyMs: 0 });
      }
      return;
    }

    // ─── Consensus Detection ─────────────────────────────
    if (req.method === 'POST' && url.pathname === '/api/consensus') {
      try {
        const body = await readBody(req);
        const { messages: msgs } = JSON.parse(body) as { messages?: Array<{ from: string; text: string }> };
        if (!msgs || msgs.length === 0) {
          respond(res, 400, { error: 'messages array required' });
          return;
        }

        const recent = msgs.slice(-5);
        const dialogue = recent.map(m => `[${m.from}]: ${m.text.slice(0, 300)}`).join('\n\n');

        const systemPrompt = [
          'You are a discussion analyst. Given a conversation between participants, determine:',
          '1. Have they converged on an agreement? (yes/no)',
          '2. What is the main disagreement or open question? (one sentence)',
          '3. What should they discuss next to make progress? (one sentence)',
          '',
          'Respond in EXACTLY this JSON format, nothing else:',
          '{"converged": true/false, "agreement": "what they agree on", "disagreement": "remaining gap", "suggestion": "next step"}',
        ].join('\n');

        const start = Date.now();
        const result = await callModel(config.model, agentDir, systemPrompt, dialogue);
        const latencyMs = Date.now() - start;

        const parsed = parseJsonFromLLM<Record<string, unknown>>(result, { raw: result });

        log(agentDir, 'consensus', `${latencyMs}ms — converged: ${parsed.converged ?? 'unknown'}`);
        respond(res, 200, { ok: true, latencyMs, ...parsed });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown';
        log(agentDir, 'error', `consensus failed: ${msg}`);
        respond(res, 500, { error: msg });
      }
      return;
    }

    // ─── Task Classification ─────────────────────────────
    if (req.method === 'POST' && url.pathname === '/api/classify') {
      try {
        const body = await readBody(req);
        const { source, content, context: classifyContext } = JSON.parse(body) as {
          source?: string;
          content?: string;
          context?: { currentLoad?: number };
        };
        if (!content) {
          respond(res, 400, { error: 'content is required' });
          return;
        }

        const contentLower = content.toLowerCase();
        const sourceLower = (source ?? '').toLowerCase();

        // Hard rule: critical signals → P0 urgent
        if (/\b(alert|crash|down|emergency|critical|p0)\b/i.test(contentLower) || sourceLower === 'alert') {
          log(agentDir, 'classify', '0ms — P0 urgent (rule: critical signal)');
          respond(res, 200, { ok: true, priority: 'P0', urgent: true, deep: true, reason: 'critical signal detected', latencyMs: 0, method: 'rule' });
          return;
        }

        // Hard rule: direct messages
        if ((DIRECT_MESSAGE_SOURCES as readonly string[]).includes(sourceLower)) {
          const trimmed = content.trim();
          // Acknowledgements → P2 not urgent
          if (/^(ok|好|沒問題|收到|understood|got it|thanks|謝|了解)[\s!.。！]*$/i.test(trimmed)) {
            log(agentDir, 'classify', '0ms — P2 (rule: ack message)');
            respond(res, 200, { ok: true, priority: 'P2', urgent: false, deep: false, reason: 'acknowledgement message', latencyMs: 0, method: 'rule' });
            return;
          }
          // Status queries → P2 urgent (fast response)
          if (/^(status|在幹嘛|你在做什麼|你好嗎|怎樣|how are you|what.?s up)[\s?？]*$/i.test(trimmed)) {
            log(agentDir, 'classify', '0ms — P2 urgent (rule: status query)');
            respond(res, 200, { ok: true, priority: 'P2', urgent: true, deep: false, reason: 'status query', latencyMs: 0, method: 'rule' });
            return;
          }
          // Other direct messages: fall through to LLM with urgent hint
        }

        // Hard rule: cron → P2 not urgent
        if (sourceLower === 'cron') {
          log(agentDir, 'classify', '0ms — P2 (rule: cron)');
          respond(res, 200, { ok: true, priority: 'P2', urgent: false, deep: false, reason: 'scheduled task', latencyMs: 0, method: 'rule' });
          return;
        }

        // Hard rule: auto-commit noise → P3
        if (sourceLower === 'workspace' && /auto.?commit|chore\(auto/i.test(contentLower)) {
          log(agentDir, 'classify', '0ms — P3 (rule: auto-commit)');
          respond(res, 200, { ok: true, priority: 'P3', urgent: false, deep: false, reason: 'auto-commit noise', latencyMs: 0, method: 'rule' });
          return;
        }

        // LLM classify for ambiguous cases
        const classifyPrompt = [
          'You classify incoming tasks/messages for an AI agent by priority and urgency.',
          '',
          'Respond with JSON only: {"priority": "P0"|"P1"|"P2"|"P3", "urgent": true/false, "deep": true/false, "reason": "one line"}',
          '',
          'Priority levels:',
          '- P0: Critical — system down, data loss, security issues',
          '- P1: Important — user requests, bugs, time-sensitive tasks',
          '- P2: Normal — scheduled tasks, learning, routine work',
          '- P3: Low — noise, auto-generated, can be skipped',
          '',
          'urgent: needs response within minutes (not hours)',
          'deep: needs full thinking cycle (vs quick answer)',
          (DIRECT_MESSAGE_SOURCES as readonly string[]).includes(sourceLower) ? '\nNote: this is a direct message — lean towards urgent=true' : '',
        ].filter(Boolean).join('\n');

        const input = [
          `Source: ${source ?? 'unknown'}`,
          `Content: ${content.slice(0, 500)}`,
          classifyContext ? `Context: ${JSON.stringify(classifyContext)}` : '',
        ].filter(Boolean).join('\n');

        const start = Date.now();
        const result = await callModel(config.model, agentDir, classifyPrompt, input);
        const latencyMs = Date.now() - start;

        const parsed = parseJsonFromLLM<{ priority?: string; urgent?: boolean; deep?: boolean; reason?: string }>(
          result,
          { priority: 'P1', urgent: false, deep: true, reason: 'parse failed' },
        );

        const validPriorities = ['P0', 'P1', 'P2', 'P3'];
        const priority = validPriorities.includes(parsed.priority ?? '') ? parsed.priority! : 'P1';

        log(agentDir, 'classify', `${latencyMs}ms — ${source ?? '?'} → ${priority} urgent=${parsed.urgent ?? false} deep=${parsed.deep ?? true}`);
        respond(res, 200, {
          ok: true,
          priority,
          urgent: parsed.urgent ?? false,
          deep: parsed.deep ?? true,
          reason: parsed.reason ?? '',
          latencyMs,
          method: 'llm',
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown';
        log(agentDir, 'error', `classify failed: ${msg}`);
        // Fail-open: return safe default (P1, not urgent, needs deep thinking)
        respond(res, 200, { ok: true, priority: 'P1', urgent: false, deep: true, reason: `classify error: ${msg}`, latencyMs: 0, method: 'error' });
      }
      return;
    }

    // ─── Continuation Check ─────────────────────────────
    if (req.method === 'POST' && url.pathname === '/api/continuation-check') {
      try {
        const body = await readBody(req);
        const { hasUnprocessedInbox, lastActionSummary, inProgressWork, source } = JSON.parse(body) as {
          hasUnprocessedInbox?: boolean;
          lastActionSummary?: string;
          inProgressWork?: string;
          source?: string;
        };

        // Hard rule: unprocessed inbox → always continue
        if (hasUnprocessedInbox) {
          log(agentDir, 'continuation', '0ms — continue (rule: unprocessed inbox)');
          respond(res, 200, { ok: true, shouldContinue: true, deep: true, reason: 'unprocessed inbox items', latencyMs: 0, method: 'rule' });
          return;
        }

        // Hard rule: no action summary → nothing to continue
        if (!lastActionSummary) {
          log(agentDir, 'continuation', '0ms — rest (rule: no previous action)');
          respond(res, 200, { ok: true, shouldContinue: false, deep: false, reason: 'no previous action to continue', latencyMs: 0, method: 'rule' });
          return;
        }

        // LLM evaluate: should agent continue or rest?
        const continuationPrompt = [
          'You decide if an AI agent should immediately continue working or rest until next scheduled cycle.',
          '',
          'Respond with JSON only: {"shouldContinue": true/false, "deep": true/false, "reason": "one line"}',
          '',
          'CONTINUE when:',
          '- Last action explicitly mentions "next step" or has unfinished multi-step work',
          '- In-progress work that would lose context if paused',
          '- Multi-step task mid-execution',
          '',
          'REST when:',
          '- Last action was a complete unit of work (learning, review, report)',
          '- No clear next step mentioned',
          '- Agent just sent a message and is waiting for reply',
          '- Task was routine/scheduled (cron, daily review)',
        ].join('\n');

        const input = [
          `Last action: ${lastActionSummary.slice(0, 500)}`,
          inProgressWork ? `In-progress: ${inProgressWork.slice(0, 300)}` : '',
          source ? `Trigger source: ${source}` : '',
        ].filter(Boolean).join('\n');

        const start = Date.now();
        const result = await callModel(config.model, agentDir, continuationPrompt, input);
        const latencyMs = Date.now() - start;

        const parsed = parseJsonFromLLM<{ shouldContinue?: boolean; deep?: boolean; reason?: string }>(
          result,
          { shouldContinue: false, reason: 'parse failed' },
        );

        log(agentDir, 'continuation', `${latencyMs}ms — ${parsed.shouldContinue ? 'CONTINUE' : 'rest'}: ${parsed.reason ?? ''}`);
        respond(res, 200, {
          ok: true,
          shouldContinue: parsed.shouldContinue ?? false,
          deep: parsed.deep ?? false,
          reason: parsed.reason ?? '',
          latencyMs,
          method: 'llm',
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown';
        log(agentDir, 'error', `continuation-check failed: ${msg}`);
        // Fail-closed: don't continue on error (next scheduled cycle will catch up)
        respond(res, 200, { ok: true, shouldContinue: false, deep: false, reason: `continuation-check error: ${msg}`, latencyMs: 0, method: 'error' });
      }
      return;
    }

    // ─── Acknowledge Pattern — Kuro marks a pattern as known/harmless ──
    if (req.method === 'POST' && url.pathname === '/api/acknowledge-pattern') {
      try {
        const body = await readBody(req);
        const { pattern, ttlHours, reason } = JSON.parse(body) as {
          pattern?: string; ttlHours?: number; reason?: string;
        };
        if (!pattern) {
          respond(res, 400, { error: 'pattern is required' });
          return;
        }
        const ttl = Math.min(Math.max(ttlHours ?? 6, 1), 48); // 1-48h, default 6h
        const ackPath = join(agentDir, 'logs', 'acknowledged-patterns.json');
        let patterns: Array<{ pattern: string; acknowledgedAt: number; expiresAt: number; reason?: string }> = [];
        try {
          if (existsSync(ackPath)) {
            patterns = JSON.parse(readFileSync(ackPath, 'utf-8'));
          }
        } catch { /* start fresh */ }

        const now = Date.now();
        // Clean expired + upsert
        patterns = patterns.filter(p => now < p.expiresAt && p.pattern.toLowerCase() !== pattern.toLowerCase());
        patterns.push({ pattern, acknowledgedAt: now, expiresAt: now + ttl * 3600000, reason });
        writeFileSync(ackPath, JSON.stringify(patterns, null, 2));

        log(agentDir, 'acknowledge', `pattern "${pattern}" acknowledged for ${ttl}h: ${reason ?? 'no reason'}`);
        respond(res, 200, { ok: true, pattern, ttlHours: ttl, expiresAt: new Date(now + ttl * 3600000).toISOString() });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown';
        respond(res, 400, { error: msg });
      }
      return;
    }

    // ─── List Acknowledged Patterns ──────────────────────
    if (req.method === 'GET' && url.pathname === '/api/acknowledge-pattern') {
      try {
        const ackPath = join(agentDir, 'logs', 'acknowledged-patterns.json');
        let patterns: Array<{ pattern: string; acknowledgedAt: number; expiresAt: number; reason?: string }> = [];
        try {
          if (existsSync(ackPath)) {
            patterns = JSON.parse(readFileSync(ackPath, 'utf-8'));
          }
        } catch { /* empty */ }
        const now = Date.now();
        const active = patterns.filter(p => now < p.expiresAt);
        respond(res, 200, { ok: true, patterns: active.map(p => ({
          pattern: p.pattern,
          reason: p.reason,
          acknowledgedAt: new Date(p.acknowledgedAt).toISOString(),
          expiresAt: new Date(p.expiresAt).toISOString(),
          remainingHours: Math.round((p.expiresAt - now) / 3600000 * 10) / 10,
        }))});
      } catch (err) {
        respond(res, 500, { error: err instanceof Error ? err.message : 'unknown' });
      }
      return;
    }

    respond(res, 404, { error: 'not found' });
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      log(agentDir, 'server', `port ${port} in use — retrying in 2s`);
      setTimeout(() => server.listen(port), 2000);
    } else {
      throw err;
    }
  });

  server.listen(port, () => {
    log(agentDir, 'server', `listening on http://localhost:${port}`);
  });
}
