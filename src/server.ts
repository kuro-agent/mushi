/**
 * mushi — HTTP server (health, status, perception, inbox)
 */

import { existsSync, mkdirSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AgentConfig, PerceptionSignal, Message, TriageRequest, LegacyTriageRequest, TriageEventType, ModelConfig } from './types.js';
import { log, parseJsonFromLLM } from './utils.js';
import { callModel, callModelWithThinking, ModelPriority, modelQueue } from './model.js';
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
type TriageProviderMode = 'hc1' | 'omlx' | 'shadow';
type TriageAction = 'skip' | 'quick' | 'wake' | 'invalid';
type TriageMethod = 'rule' | 'llm' | 'error' | 'validation';

interface TriageRuleCounter {
  rule: string;
  count: number;
  lastHitAt: number;
  actionCounts: Record<TriageAction, number>;
  methodCounts: Record<TriageMethod, number>;
}

const triageRuleCounters = new Map<string, TriageRuleCounter>();
let triageRuleTotalHits = 0;

function recordTriageRuleHit(rule: string, action: TriageAction, method: TriageMethod): void {
  const existing = triageRuleCounters.get(rule);
  if (existing) {
    existing.count += 1;
    existing.lastHitAt = Date.now();
    existing.actionCounts[action] += 1;
    existing.methodCounts[method] += 1;
  } else {
    triageRuleCounters.set(rule, {
      rule,
      count: 1,
      lastHitAt: Date.now(),
      actionCounts: {
        skip: action === 'skip' ? 1 : 0,
        quick: action === 'quick' ? 1 : 0,
        wake: action === 'wake' ? 1 : 0,
        invalid: action === 'invalid' ? 1 : 0,
      },
      methodCounts: {
        rule: method === 'rule' ? 1 : 0,
        llm: method === 'llm' ? 1 : 0,
        error: method === 'error' ? 1 : 0,
        validation: method === 'validation' ? 1 : 0,
      },
    });
  }
  triageRuleTotalHits += 1;
}

function getTriageProviderMode(): TriageProviderMode {
  const raw = (process.env.MUSHI_TRIAGE_PROVIDER ?? 'shadow').trim().toLowerCase();
  if (raw === 'hc1' || raw === 'omlx' || raw === 'shadow') return raw;
  return 'shadow';
}

function buildOmlxTriageModel(config: AgentConfig): ModelConfig {
  // Use dedicated triage_model (0.8B) if configured, else fallback to main model
  if (config.triage_model) return config.triage_model;
  return {
    ...config.model,
    provider: 'openai',
    base_url: 'http://localhost:8000',
    model: 'Qwen3.5-0.8B-MLX-4bit',
    api_key: 'omlx-local',
    max_tokens: 150,
    temperature: 0.7,
    top_p: 0.8,
  };
}

interface TriageProviderResult {
  provider: 'hc1' | 'omlx';
  output?: string;
  latencyMs: number;
  error?: string;
}

interface ParsedTriageDecision {
  action: 'skip' | 'quick' | 'wake';
  reason: string;
}

function writeTriageTelemetry(agentDir: string, entry: Record<string, unknown>): void {
  try {
    const logDir = join(agentDir, 'logs');
    if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
    appendFileSync(join(logDir, 'triage-telemetry.jsonl'), JSON.stringify({
      ts: new Date().toISOString(),
      ...entry,
    }) + '\n', 'utf-8');
  } catch { /* fire-and-forget */ }
}

function parseTriageDecision(raw: string, allowedActions: readonly string[]): ParsedTriageDecision {
  const parsed = parseJsonFromLLM<{ action?: string; reason?: string }>(
    raw,
    { action: 'wake', reason: 'parse failed — defaulting to wake' },
  );
  const action = allowedActions.includes(parsed.action ?? '') ? parsed.action! : 'wake';
  return { action: action as 'skip' | 'quick' | 'wake', reason: parsed.reason ?? '' };
}

async function callTriageProvider(
  provider: 'hc1' | 'omlx',
  modelConfig: ModelConfig,
  agentDir: string,
  systemPrompt: string,
  input: string,
  enableThinking: boolean,
  priority: number,
): Promise<TriageProviderResult> {
  const start = Date.now();
  try {
    const output = enableThinking
      ? await callModelWithThinking(modelConfig, agentDir, systemPrompt, input, true, priority)
      : await callModel(modelConfig, agentDir, systemPrompt, input, priority);
    return { provider, output, latencyMs: Date.now() - start };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    return { provider, latencyMs: Date.now() - start, error: msg };
  }
}

async function runTriageDecision(
  config: AgentConfig,
  agentDir: string,
  meta: {
    trigger: string;
    source?: string;
    event: string;
    mode: 'dm' | 'event';
  },
  systemPrompt: string,
  input: string,
  allowedActions: readonly string[],
  opts: {
    enableThinking: boolean;
    priority: number;
  },
): Promise<{ decision: ParsedTriageDecision; latencyMs: number; providerUsed: 'hc1' | 'omlx' }> {
  const mode = getTriageProviderMode();
  const hc1Model = config.model;
  const omlxModel = buildOmlxTriageModel(config);

  if (mode === 'hc1') {
    const hc1 = await callTriageProvider('hc1', hc1Model, agentDir, systemPrompt, input, opts.enableThinking, opts.priority);
    if (hc1.error || !hc1.output) {
      throw new Error(hc1.error ?? 'hc1 empty response');
    }
    return {
      decision: parseTriageDecision(hc1.output, allowedActions),
      latencyMs: hc1.latencyMs,
      providerUsed: 'hc1',
    };
  }

  if (mode === 'omlx') {
    const omlx = await callTriageProvider('omlx', omlxModel, agentDir, systemPrompt, input, opts.enableThinking, opts.priority);
    if (omlx.error || !omlx.output) {
      throw new Error(omlx.error ?? 'omlx empty response');
    }
    return {
      decision: parseTriageDecision(omlx.output, allowedActions),
      latencyMs: omlx.latencyMs,
      providerUsed: 'omlx',
    };
  }

  const [hc1, omlx] = await Promise.all([
    callTriageProvider('hc1', hc1Model, agentDir, systemPrompt, input, opts.enableThinking, opts.priority),
    callTriageProvider('omlx', omlxModel, agentDir, systemPrompt, input, opts.enableThinking, opts.priority),
  ]);

  const hc1Decision = hc1.output ? parseTriageDecision(hc1.output, allowedActions) : null;
  const omlxDecision = omlx.output ? parseTriageDecision(omlx.output, allowedActions) : null;

  writeTriageTelemetry(agentDir, {
    type: 'triage_shadow',
    trigger: meta.trigger,
    source: meta.source,
    event: meta.event,
    triageMode: meta.mode,
    selected: 'hc1',
    match: hc1Decision && omlxDecision ? hc1Decision.action === omlxDecision.action : null,
    hc1: {
      latencyMs: hc1.latencyMs,
      action: hc1Decision?.action ?? null,
      reason: hc1Decision?.reason ?? null,
      error: hc1.error ?? null,
    },
    omlx: {
      latencyMs: omlx.latencyMs,
      action: omlxDecision?.action ?? null,
      reason: omlxDecision?.reason ?? null,
      error: omlx.error ?? null,
    },
  });

  if (!hc1Decision) {
    throw new Error(hc1.error ?? 'hc1 empty response');
  }

  return {
    decision: hc1Decision,
    latencyMs: hc1.latencyMs,
    providerUsed: 'hc1',
  };
}

// --- Request normalization: legacy → generic ---

const LEGACY_TRIGGER_MAP: Record<string, TriageEventType> = {
  heartbeat: 'timer',
  cron: 'scheduled',
  workspace: 'change',
  alert: 'alert',
  startup: 'startup',
  mobile: 'alert',
  telegram: 'message',
  room: 'message',
  chat: 'message',
};

interface NormalizedTriage {
  event: TriageEventType;
  source?: string;
  priority_hint?: 'high' | 'normal' | 'low';
  context: Record<string, unknown>;
  rules?: Array<{ match: Record<string, unknown>; action: 'wake' | 'skip' | 'quick'; reason: string }>;
  _legacy?: LegacyTriageRequest;  // preserved for backwards compat in hard rules
}

function normalizeTriage(body: Record<string, unknown>): NormalizedTriage {
  // New format: has `event` field
  if (body.event && typeof body.event === 'string') {
    const req = body as unknown as TriageRequest;
    return {
      event: req.event,
      source: req.source,
      priority_hint: req.priority_hint,
      context: req.context ?? {},
      rules: req.rules,
    };
  }

  // Legacy format: has `trigger` field
  if (body.trigger && typeof body.trigger === 'string') {
    const legacy = body as unknown as LegacyTriageRequest;
    const meta = (legacy.metadata ?? {}) as Record<string, unknown>;
    const event = LEGACY_TRIGGER_MAP[legacy.trigger] ?? 'custom';

    // Map legacy metadata to generic context
    const context: Record<string, unknown> = { ...meta };
    if (meta.lastThinkAgo != null) context.idle_seconds = meta.lastThinkAgo;
    if (meta.perceptionChangedCount != null) context.changes_count = meta.perceptionChangedCount;
    if (meta.messageText != null) context.message_text = meta.messageText;
    if (meta.inboxEmpty != null) context.inbox_empty = meta.inboxEmpty;
    if (meta.hasOverdueTasks != null) context.has_overdue_tasks = meta.hasOverdueTasks;

    return {
      event,
      source: legacy.source,
      context,
      _legacy: legacy,
    };
  }

  // Unknown format — treat as custom wake
  return { event: 'custom', context: body };
}

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
  // 0.8B for classification tasks (triage/classify/route/continuation)
  const triageModel = config.triage_model ?? config.model;

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
        queue: modelQueue.stats(),
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/health/triage-rules') {
      const rules = [...triageRuleCounters.values()]
        .sort((a, b) => b.count - a.count)
        .slice(0, 20)
        .map((item) => ({
          rule: item.rule,
          count: item.count,
          lastHitAt: new Date(item.lastHitAt).toISOString(),
          actionCounts: item.actionCounts,
          methodCounts: item.methodCounts,
        }));

      respond(res, 200, {
        ok: true,
        totalHits: triageRuleTotalHits,
        uniqueRules: triageRuleCounters.size,
        rules,
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
        const rawBody = JSON.parse(body) as Record<string, unknown>;

        // Normalize: accept both legacy (trigger/source/metadata) and new (event/context) format
        const norm = normalizeTriage(rawBody);

        // Validate: need at least an event type
        if (!norm.event) {
          recordTriageRuleHit('validation_missing_event', 'invalid', 'validation');
          respond(res, 400, { error: 'event type is required (or legacy: trigger)' });
          return;
        }

        // For trail/logging compatibility, derive trigger name
        const trigger = norm._legacy?.trigger ?? norm.event;
        const source = norm.source;
        const metadata = norm._legacy?.metadata as { inboxEmpty?: boolean; lastThinkAgo?: number; hasOverdueTasks?: boolean; messageText?: string; metsukeActivePatterns?: string[]; metsukeRecentCategories?: string[] } | undefined;

        // --- User-provided rules (new format) ---
        if (norm.rules?.length) {
          for (const rule of norm.rules) {
            const matches = Object.entries(rule.match).every(([k, v]) => {
              const ctx = norm.context[k];
              if (typeof v === 'string' && v.startsWith('<') && typeof ctx === 'number') {
                return ctx < Number(v.slice(1));
              }
              if (typeof v === 'string' && v.startsWith('>') && typeof ctx === 'number') {
                return ctx > Number(v.slice(1));
              }
              if (k === 'event') return norm.event === v;
              return ctx === v;
            });
            if (matches) {
              trailFromTriage(trigger, source, rule.action, rule.reason, 'rule');
              recordTriageRuleHit(`user_rule:${rule.action}:${rule.reason.slice(0, 80)}`, rule.action, 'rule');
              respond(res, 200, { ok: true, action: rule.action, reason: rule.reason, latencyMs: 0, method: 'rule' });
              return;
            }
          }
        }

        // --- Built-in hard rules ---

        // Alert/startup always wake
        if (norm.event === 'alert' || norm.event === 'startup') {
          trailFromTriage(trigger, source, 'wake', `${norm.event} always wakes`, 'rule');
          recordTriageRuleHit(`event_${norm.event}_always_wake`, 'wake', 'rule');
          respond(res, 200, { ok: true, action: 'wake', reason: `${norm.event} always wakes`, latencyMs: 0, method: 'rule' });
          return;
        }

        // Legacy compat: mobile always wake
        if (trigger === 'mobile') {
          trailFromTriage(trigger, source, 'wake', 'mobile always wakes', 'rule');
          recordTriageRuleHit('legacy_mobile_always_wake', 'wake', 'rule');
          respond(res, 200, { ok: true, action: 'wake', reason: 'mobile always wakes', latencyMs: 0, method: 'rule' });
          return;
        }

        const idleSeconds = (norm.context.idle_seconds as number) ?? (metadata?.lastThinkAgo as number) ?? Infinity;
        const changesCount = (norm.context.changes_count as number) ?? (metadata as Record<string, unknown>)?.perceptionChangedCount as number ?? Infinity;

        // Scheduled heartbeat-like check: skip if recently active
        if (norm.event === 'scheduled' && source && /heartbeat|pending.tasks/i.test(source)) {
          if (idleSeconds < 1500) {
            const reason = `scheduled heartbeat redundant — last active ${idleSeconds}s ago`;
            log(agentDir, 'triage', `0ms — scheduled/heartbeat → skip (rule: ${reason})`);
            trailFromTriage(trigger, source, 'skip', reason, 'rule');
            recordTriageRuleHit('scheduled_heartbeat_recently_active_skip', 'skip', 'rule');
            respond(res, 200, { ok: true, action: 'skip', reason, latencyMs: 0, method: 'rule' });
            return;
          }
        }

        // Metsuke avoidance override (legacy compat — mini-agent specific)
        const avoidancePatterns = (metadata?.metsukeActivePatterns ?? norm.context.avoidance_patterns as string[]) ?? [];
        const hasAvoidance = avoidancePatterns.some((p: string) =>
          ['Learning as Avoidance', 'Planning Loop', 'Conservative Default', 'Comfort Zone Retreat'].includes(p),
        );
        if (hasAvoidance && norm.event === 'timer') {
          const reason = `avoidance override — active patterns: ${avoidancePatterns.join(', ')}`;
          log(agentDir, 'triage', `0ms — timer → wake (rule: ${reason})`);
          trailFromTriage(trigger, source, 'wake', reason, 'rule');
          recordTriageRuleHit('timer_avoidance_override_wake', 'wake', 'rule');
          respond(res, 200, { ok: true, action: 'wake', reason, latencyMs: 0, method: 'rule' });
          return;
        }

        // Timer optimization — skip when recently active and environment barely changed
        if (norm.event === 'timer' && idleSeconds < 300 && changesCount <= 1) {
          const reason = `timer skip — idle=${idleSeconds}s < 5min, changes=${changesCount} <= 1`;
          log(agentDir, 'triage', `0ms — timer → skip (rule: ${reason})`);
          trailFromTriage(trigger, source, 'skip', reason, 'rule');
          recordTriageRuleHit('timer_recent_active_low_change_skip', 'skip', 'rule');
          respond(res, 200, { ok: true, action: 'skip', reason, latencyMs: 0, method: 'rule' });
          return;
        }

        // Direct message triage — classify as quick or wake
        const isDirectMessage = norm.event === 'message' || (DIRECT_MESSAGE_SOURCES as readonly string[]).includes(trigger);
        if (isDirectMessage) {
          // Extract message text from either format
          const messageText = (norm.context.message_text as string) ?? metadata?.messageText;

          // No message text → can't classify, default to wake
          if (!messageText) {
            trailFromTriage(trigger, source, 'wake', 'direct message without text — defaulting to wake', 'rule');
            recordTriageRuleHit('direct_message_missing_text_default_wake', 'wake', 'rule');
            respond(res, 200, { ok: true, action: 'wake', reason: 'direct message without text — defaulting to wake', latencyMs: 0, method: 'rule' });
            return;
          }

          const dmPrompt = [
            'You classify user messages for an AI agent. Decide: can this be answered quickly from memory/status (quick), or does it need deep thinking/action (wake)?',
            '',
            'Respond with JSON only: {"action": "quick" or "wake", "reason": "one line"}',
            '',
            'QUICK — lightweight response (~5K tokens, 5-15s), answer from memory/status:',
            '- Status queries: "在幹嘛", "what are you doing", "status"',
            '- Simple factual questions answerable from memory',
            '- Greetings, acknowledgements, short reactions',
            '- "OK", "好", "understood", "收到" type messages',
            '- Confirmations or approvals of previously discussed plans',
            '- Simple follow-up questions on recent context',
            '',
            'WAKE — needs full thinking cycle (~50K tokens, 60-120s):',
            '- Requests to DO something (implement, fix, create, deploy)',
            '- Complex questions requiring research or multi-step reasoning',
            '- Messages with URLs to analyze',
            '- Instructions, directives, task assignments',
            '- Questions about external topics needing web lookup',
            '- Architecture discussions, design decisions',
            '- Messages that reference multiple systems or require cross-referencing',
          ].join('\n');

          const msgInput = `Message: ${messageText.slice(0, 500)}`;

          const decisionResult = await runTriageDecision(
            config,
            agentDir,
            {
              trigger,
              source,
              event: norm.event,
              mode: 'dm',
            },
            dmPrompt,
            msgInput,
            ['quick', 'wake'] as const,
            {
              enableThinking: true,
              priority: ModelPriority.INTERACTIVE,
            },
          );
          const latencyMs = decisionResult.latencyMs;
          const action = decisionResult.decision.action === 'quick' ? 'quick' : 'wake';
          const reason = decisionResult.decision.reason;

          log(agentDir, 'triage', `${latencyMs}ms — DM ${trigger} → ${action} [think/${decisionResult.providerUsed}]: ${messageText.slice(0, 80)}`);
          trailFromTriage(trigger, source, action, reason, 'llm');
          recordTriageRuleHit('direct_message_llm_decision', action, 'llm');
          respond(res, 200, { ok: true, action, reason, latencyMs, method: 'llm' });
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
          '- if metsukeActivePatterns contains avoidance patterns (Learning as Avoidance, Planning Loop, etc.) → lean wake (agent needs coaching intervention)',
        ].join('\n');

        const input = [
          `Event: ${norm.event}`,
          source ? `Source: ${source}` : '',
          `Context: ${JSON.stringify(norm.context)}`,
        ].filter(Boolean).join('\n');

        const decisionResult = await runTriageDecision(
          config,
          agentDir,
          {
            trigger,
            source,
            event: norm.event,
            mode: 'event',
          },
          triagePrompt,
          input,
          ['skip', 'quick', 'wake'] as const,
          {
            enableThinking: false,
            priority: ModelPriority.BACKGROUND,
          },
        );

        const action = decisionResult.decision.action;
        const reason = decisionResult.decision.reason;
        const latencyMs = decisionResult.latencyMs;

        log(agentDir, 'triage', `${latencyMs}ms — ${trigger}/${source ?? '?'} → ${action} [${decisionResult.providerUsed}]`);
        trailFromTriage(trigger, source, action, reason, 'llm');
        recordTriageRuleHit('event_llm_decision', action, 'llm');
        respond(res, 200, { ok: true, action, reason, latencyMs, method: 'llm' });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown';
        log(agentDir, 'error', `triage failed: ${msg}`);
        // On error, always wake (fail-open)
        // trail not written in catch — trigger/source may not be parsed
        recordTriageRuleHit('triage_error_fail_open_wake', 'wake', 'error');
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
        const result = await callModel(config.model, agentDir, systemPrompt, `Message from Alex: ${message.slice(0, 500)}`, ModelPriority.INTERACTIVE);
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
          'Think briefly, then respond with JSON only.',
          '',
          'Output format: {"priority": "P0"|"P1"|"P2"|"P3", "urgent": true/false, "deep": true/false, "reason": "one line"}',
          '',
          'P0: Critical — system down, data loss, security',
          'P1: Important — user requests, bugs, time-sensitive',
          'P2: Normal — scheduled, learning, routine',
          'P3: Low — noise, auto-generated',
          '',
          'urgent: needs response within minutes. deep: needs full thinking cycle.',
          (DIRECT_MESSAGE_SOURCES as readonly string[]).includes(sourceLower) ? 'Note: direct message — lean urgent=true' : '',
        ].filter(Boolean).join('\n');

        const input = [
          `Source: ${source ?? 'unknown'}`,
          `Content: ${content.slice(0, 500)}`,
          classifyContext ? `Context: ${JSON.stringify(classifyContext)}` : '',
        ].filter(Boolean).join('\n');

        const start = Date.now();
        const result = await callModel(triageModel, agentDir, classifyPrompt, input, ModelPriority.DECISION);
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
        const result = await callModel(triageModel, agentDir, continuationPrompt, input);
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

    // ─── Route — Cognitive Mesh task routing coordinator (Phase 5) ──
    if (req.method === 'POST' && url.pathname === '/api/route') {
      try {
        const body = await readBody(req);
        const { trigger, cluster } = JSON.parse(body) as {
          trigger: string;
          cluster: {
            primaryBusy: boolean;
            queueDepth: number;
            totalInstances: number;
            maxInstances: number;
            specialists: Array<{ id: string; perspective?: string; status: string }>;
          };
        };

        const triggerBase = trigger.replace('trigger:', '');

        // Hard rule: direct messages → always self
        const directSources = ['telegram', 'telegram-user', 'room', 'chat'];
        if (directSources.includes(triggerBase)) {
          log(agentDir, 'route', `0ms — self (rule: direct message ${triggerBase})`);
          respond(res, 200, { ok: true, route: 'self', reason: 'identity-required', latencyMs: 0, method: 'rule' });
          return;
        }

        // Hard rule: alert → always self
        if (triggerBase === 'alert') {
          log(agentDir, 'route', '0ms — self (rule: alert)');
          respond(res, 200, { ok: true, route: 'self', reason: 'alert-handling', latencyMs: 0, method: 'rule' });
          return;
        }

        // Hard rule: primary not busy → self
        if (!cluster.primaryBusy) {
          log(agentDir, 'route', '0ms — self (rule: primary idle)');
          respond(res, 200, { ok: true, route: 'self', reason: 'primary-idle', latencyMs: 0, method: 'rule' });
          return;
        }

        // Hard rule: idle specialist available → forward
        const idle = cluster.specialists.find(s => s.status === 'idle');
        if (idle) {
          log(agentDir, 'route', `0ms — forward to ${idle.id} (rule: idle specialist)`);
          respond(res, 200, { ok: true, route: 'forward', target: idle.id, perspective: idle.perspective, reason: 'idle-specialist', latencyMs: 0, method: 'rule' });
          return;
        }

        // Hard rule: at max instances → queue
        if (cluster.totalInstances >= cluster.maxInstances) {
          log(agentDir, 'route', '0ms — queue (rule: at max instances)');
          respond(res, 200, { ok: true, route: 'queue', reason: 'max-instances-reached', latencyMs: 0, method: 'rule' });
          return;
        }

        // LLM: should we spawn a new specialist?
        const routePrompt = [
          'You are a lightweight task router for a multi-instance AI agent.',
          'Decide: should this trigger spawn a new specialist instance, or just queue for the primary?',
          '',
          'Respond with JSON only: {"route": "spawn"|"queue", "perspective": "research"|"code"|"chat", "reason": "one line"}',
          '',
          'SPAWN when: independent task (research, code review, web fetch) that benefits from parallel execution.',
          'QUEUE when: short task (<30s), needs shared state, or uncertain.',
        ].join('\n');

        const input = [
          `Trigger: ${trigger}`,
          `Queue depth: ${cluster.queueDepth}`,
          `Current instances: ${cluster.totalInstances}/${cluster.maxInstances}`,
        ].join('\n');

        const start = Date.now();
        const result = await callModelWithThinking(triageModel, agentDir, routePrompt, input, false);
        const latencyMs = Date.now() - start;

        const parsed = parseJsonFromLLM<{ route?: string; perspective?: string; reason?: string }>(
          result,
          { route: 'queue', reason: 'parse failed' },
        );

        const route = parsed.route === 'spawn' ? 'spawn' : 'queue';
        log(agentDir, 'route', `${latencyMs}ms — ${route} [think] (${parsed.perspective ?? 'research'}): ${parsed.reason ?? ''}`);
        respond(res, 200, {
          ok: true,
          route,
          perspective: parsed.perspective ?? 'research',
          reason: parsed.reason ?? '',
          latencyMs,
          method: 'llm',
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown';
        log(agentDir, 'error', `route failed: ${msg}`);
        respond(res, 200, { ok: true, route: 'self', reason: `route error: ${msg}`, latencyMs: 0, method: 'error' });
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

    // (duplicate /api/route removed — replaced by Phase 5 version above)

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
