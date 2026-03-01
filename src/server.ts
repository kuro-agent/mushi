/**
 * mushi — HTTP server (health, status, perception, inbox)
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AgentConfig, PerceptionSignal, Message } from './types.js';
import { log } from './utils.js';
import { callModel } from './model.js';
import { getRoomWatcherStatus } from './room-watcher.js';

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
        loop: { interval: config.loop.interval },
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
        const alwaysWake = ['alert', 'mobile'];
        if (alwaysWake.includes(trigger)) {
          respond(res, 200, { ok: true, action: 'wake', reason: `${trigger} always wakes`, latencyMs: 0, method: 'rule' });
          return;
        }

        // Direct message triage — classify as instant (fast /api/ask) or wake (full OODA)
        const directMessageTriggers = ['telegram', 'room', 'chat'];
        if (directMessageTriggers.includes(trigger)) {
          // No message text → can't classify, default to wake
          if (!metadata?.messageText) {
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

          let parsed: { action?: string; reason?: string };
          try {
            const jsonMatch = result.match(/\{[\s\S]*\}/);
            parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : { action: 'wake', reason: 'parse failed — defaulting to wake' };
          } catch {
            parsed = { action: 'wake', reason: 'parse failed — defaulting to wake' };
          }

          // Validate action — only allow instant or wake
          const action = parsed.action === 'instant' ? 'instant' : 'wake';

          log(agentDir, 'triage', `${latencyMs}ms — DM ${trigger} → ${action}: ${metadata.messageText.slice(0, 80)}`);
          respond(res, 200, { ok: true, action, reason: parsed.reason ?? '', latencyMs, method: 'llm' });
          return;
        }

        // LLM triage for ambiguous cases (workspace, cron, heartbeat, etc.)
        const triagePrompt = [
          'You classify trigger events for an AI agent. Decide: should this trigger start a full thinking cycle (expensive) or be skipped (noise)?',
          '',
          'Respond with JSON only: {"action": "wake" or "skip", "reason": "one line"}',
          '',
          'Guidelines:',
          '- workspace changes from auto-commit (agent\'s own changes) → skip',
          '- workspace changes from external edits → wake',
          '- cron heartbeat with no overdue tasks → skip',
          '- cron with overdue tasks → wake',
          '- startup/bootstrap → wake',
          '- heartbeat when last think was recent (<5min) and nothing changed → skip',
        ].join('\n');

        const input = [
          `Trigger: ${trigger}`,
          source ? `Source: ${source}` : '',
          metadata ? `Metadata: ${JSON.stringify(metadata)}` : '',
        ].filter(Boolean).join('\n');

        const start = Date.now();
        const result = await callModel(config.model, agentDir, triagePrompt, input);
        const latencyMs = Date.now() - start;

        let parsed: { action?: string; reason?: string };
        try {
          const jsonMatch = result.match(/\{[\s\S]*\}/);
          parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : { action: 'wake', reason: 'parse failed — defaulting to wake' };
        } catch {
          parsed = { action: 'wake', reason: 'parse failed — defaulting to wake' };
        }

        log(agentDir, 'triage', `${latencyMs}ms — ${trigger}/${source ?? '?'} → ${parsed.action}`);
        respond(res, 200, { ok: true, action: parsed.action ?? 'wake', reason: parsed.reason ?? '', latencyMs, method: 'llm' });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown';
        log(agentDir, 'error', `triage failed: ${msg}`);
        // On error, always wake (fail-open)
        respond(res, 200, { ok: true, action: 'wake', reason: `triage error: ${msg}`, latencyMs: 0, method: 'error' });
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

        let parsed: { isDuplicate?: boolean; matchedIndex?: number; similarity?: number; reason?: string };
        try {
          const jsonMatch = result.match(/\{[\s\S]*\}/);
          parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : { isDuplicate: false };
        } catch {
          parsed = { isDuplicate: false, reason: 'parse failed — allowing write' };
        }

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

        let parsed: Record<string, unknown>;
        try {
          const jsonMatch = result.match(/\{[\s\S]*\}/);
          parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : { raw: result };
        } catch {
          parsed = { raw: result };
        }

        log(agentDir, 'consensus', `${latencyMs}ms — converged: ${parsed.converged ?? 'unknown'}`);
        respond(res, 200, { ok: true, latencyMs, ...parsed });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown';
        log(agentDir, 'error', `consensus failed: ${msg}`);
        respond(res, 500, { error: msg });
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
