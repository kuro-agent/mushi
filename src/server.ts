/**
 * mushi — HTTP server (health, status, perception, inbox)
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AgentConfig, PerceptionSignal, Message } from './types.js';
import { log } from './utils.js';
import { callModel } from './model.js';

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
