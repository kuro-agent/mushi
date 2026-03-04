/**
 * mushi — tag parser + action dispatcher
 *
 * Escalation bridge: <agent:escalate> POSTs to mini-agent's chat room,
 * making mushi a perception outpost for Kuro.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentConfig, ParsedAction } from './types.js';
import { parseInterval, log, escalateToKuro as sendToKuro } from './utils.js';

// Cross-cycle escalation dedup: track recent escalations with timestamps
// Uses normalized text as key to catch variations of the same pattern
const recentEscalations = new Map<string, number>(); // normalizedText → timestamp
const ESCALATION_DEDUP_WINDOW = 60 * 60 * 1000; // 1 hour

/**
 * Normalize escalation text for dedup comparison.
 * Strips variable parts (report counts, durations, numbers) so that
 * "poll error (second report, escalating)" and "poll error (fifth report, escalating)"
 * match as the same pattern.
 */
function normalizeEscalation(text: string): string {
  return text
    .replace(/\s*\((?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|\d+(?:st|nd|rd|th)?)\s+report[^)]*\)/gi, '')
    .replace(/\b\d+\s*(ms|s|min|minutes?|hours?|h|days?|d)\b/gi, 'N$1')
    .replace(/\b\d+\s+(times?|occurrences?|errors?|failures?)\b/gi, 'N $1')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Acknowledged patterns — patterns Kuro has confirmed as known/harmless.
 * Stored in {agentDir}/logs/acknowledged-patterns.json with TTL.
 */
interface AcknowledgedPattern {
  pattern: string;
  acknowledgedAt: number;
  expiresAt: number;
  reason?: string;
}

function loadAcknowledgedPatterns(agentDir: string): AcknowledgedPattern[] {
  try {
    const path = join(agentDir, 'logs', 'acknowledged-patterns.json');
    if (!existsSync(path)) return [];
    const data = JSON.parse(readFileSync(path, 'utf-8')) as AcknowledgedPattern[];
    return data.filter(p => Date.now() < p.expiresAt);
  } catch { return []; }
}

function matchAcknowledgedPattern(text: string, agentDir: string): string | null {
  const patterns = loadAcknowledgedPatterns(agentDir);
  const lower = text.toLowerCase();
  for (const p of patterns) {
    if (lower.includes(p.pattern.toLowerCase())) {
      return p.reason ?? p.pattern;
    }
  }
  return null;
}

// Persist dedup state across restarts
let dedupStatePath = '';

export function initDedupState(agentDir: string): void {
  dedupStatePath = join(agentDir, 'logs', 'escalation-dedup.json');
  try {
    if (existsSync(dedupStatePath)) {
      const data = JSON.parse(readFileSync(dedupStatePath, 'utf-8')) as Array<[string, number]>;
      const now = Date.now();
      for (const [text, ts] of data) {
        if (now - ts < ESCALATION_DEDUP_WINDOW) {
          recentEscalations.set(text, ts);
        }
      }
      if (recentEscalations.size > 0) {
        log(agentDir, 'dedup', `restored ${recentEscalations.size} recent escalation(s)`);
      }
    }
  } catch { /* start fresh */ }
}

export function saveDedupState(): void {
  if (!dedupStatePath) return;
  try {
    const data = [...recentEscalations.entries()];
    writeFileSync(dedupStatePath, JSON.stringify(data));
  } catch { /* best effort */ }
}

function parseAttrs(attrStr: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /(\w+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(attrStr))) attrs[m[1]!] = m[2]!;
  return attrs;
}

export function parseTags(response: string): ParsedAction[] {
  const actions: ParsedAction[] = [];
  const regex = /<agent:(\w+)([^>]*)>([\s\S]*?)<\/agent:\1>/g;

  let match;
  while ((match = regex.exec(response)) !== null) {
    const [, tag, attrStr, content] = match;
    actions.push({ tag: tag!, content: content!.trim(), attrs: parseAttrs(attrStr!) });
  }

  const selfClosing = /<agent:(\w+)([^/]*?)\/>/g;
  while ((match = selfClosing.exec(response)) !== null) {
    const [, tag, attrStr] = match;
    actions.push({ tag: tag!, content: '', attrs: parseAttrs(attrStr!) });
  }

  return actions;
}

export function dispatch(
  actions: ParsedAction[],
  config: AgentConfig,
  agentDir: string,
): { nextInterval?: number } {
  let nextInterval: number | undefined;
  const seenEscalations = new Set<string>();

  for (const action of actions) {
    switch (action.tag) {
      case 'action':
        log(agentDir, 'action', action.content);
        break;

      case 'remember': {
        const content = action.content.trim();
        // Quality gate: skip vague/short/placeholder content
        if (!content || content.length < 15 || /^(the pattern|a pattern|something|noted)$/i.test(content)
            || /^(WRITE YOUR|e\.g\.\s)/i.test(content)) {
          log(agentDir, 'memory', `filtered (too vague): ${content.slice(0, 40)}`);
          break;
        }
        const memDir = join(agentDir, config.memory.dir);
        const topic = action.attrs.topic;
        const targetFile = topic
          ? join(memDir, 'topics', `${topic}.md`)
          : join(memDir, 'MEMORY.md');

        const dir = topic ? join(memDir, 'topics') : memDir;
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

        // Dedup: skip if already in file
        try {
          const existing = readFileSync(targetFile, 'utf-8');
          if (existing.includes(content)) {
            log(agentDir, 'memory', `filtered (duplicate): ${content.slice(0, 40)}`);
            break;
          }
        } catch { /* file doesn't exist yet — ok to write */ }

        writeFileSync(targetFile, '\n- ' + content + '\n', { flag: 'a' });
        log(agentDir, 'memory', `saved to ${topic ?? 'MEMORY.md'}`);
        break;
      }

      case 'chat':
        log(agentDir, 'chat', action.content);
        console.log(`\n💬 ${config.name}: ${action.content}\n`);
        break;

      case 'escalate': {
        // Quality gate: filter meaningless escalations
        const raw = action.content.replace(/<agent:\w+[^>]*>[\s\S]*?<\/agent:\w+>/g, '').trim();
        const NOISE = /\b(no\s+change|unchanged|no\s+significant|nothing\s+(new|unusual|to\s+report)|filesystem\s+unchanged)\b/i;
        if (!raw || raw.length < 10 || NOISE.test(raw)) {
          log(agentDir, 'escalate', `filtered (noise): ${raw.slice(0, 60)}`);
          break;
        }
        // Acknowledged pattern check: skip if Kuro already confirmed this as known
        const ackReason = matchAcknowledgedPattern(raw, agentDir);
        if (ackReason) {
          log(agentDir, 'escalate', `filtered (acknowledged: ${ackReason}): ${raw.slice(0, 60)}`);
          break;
        }
        // Dedup: skip identical escalations within same dispatch (LLM repetition)
        if (seenEscalations.has(raw)) {
          log(agentDir, 'escalate', `filtered (duplicate): ${raw.slice(0, 60)}`);
          break;
        }
        seenEscalations.add(raw);
        // Cross-cycle dedup: use normalized text to catch variations of the same pattern
        const normalized = normalizeEscalation(raw);
        const now = Date.now();
        const lastSent = recentEscalations.get(normalized);
        if (lastSent && now - lastSent < ESCALATION_DEDUP_WINDOW) {
          log(agentDir, 'escalate', `filtered (recent, ${Math.round((now - lastSent) / 60000)}min ago): ${raw.slice(0, 60)}`);
          break;
        }
        // Clean old entries
        for (const [k, v] of recentEscalations) {
          if (now - v > ESCALATION_DEDUP_WINDOW) recentEscalations.delete(k);
        }
        recentEscalations.set(normalized, now);
        const text = `[mushi] ${raw}`;
        log(agentDir, 'escalate', text);
        // Fire-and-forget: try room API, fallback to /chat inbox
        sendToKuro(text, agentDir);
        break;
      }

      case 'schedule': {
        const next = action.attrs.next;
        if (next) {
          nextInterval = parseInterval(next);
          log(agentDir, 'schedule', `next cycle in ${next} (${action.attrs.reason ?? 'no reason'})`);
        }
        break;
      }

      default:
        log(agentDir, 'dispatch', `unknown tag: agent:${action.tag}`);
    }
  }

  return { nextInterval };
}
