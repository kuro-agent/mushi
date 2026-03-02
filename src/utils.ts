/**
 * mushi — pure utility functions (no state, no side effects except logging)
 */

import { existsSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

export function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + ch;
    hash |= 0;
  }
  return hash.toString(36);
}

export function parseInterval(s: string): number {
  const match = s.match(/^(\d+)(s|m|h)$/);
  if (!match) return 60_000;
  const [, num, unit] = match;
  const n = parseInt(num!);
  if (unit === 's') return n * 1_000;
  if (unit === 'm') return n * 60_000;
  return n * 3_600_000;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

export function truncateToTokens(text: string, maxTokens: number): string {
  const estimated = estimateTokens(text);
  if (estimated <= maxTokens) return text;
  const ratio = maxTokens / estimated;
  return text.slice(0, Math.floor(text.length * ratio)) + '\n...(truncated)';
}

const KURO_ROOM_URL = 'http://localhost:3001/api/room';
const KURO_CHAT_URL = 'http://localhost:3001/chat';

/**
 * Fire-and-forget: send text to Kuro via room API, fallback to /chat inbox,
 * fallback to local escalations.jsonl log.
 * Caller is responsible for formatting text (e.g. prefixing "[mushi] ").
 */
export function escalateToKuro(text: string, agentDir: string): void {
  fetch(KURO_ROOM_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'mushi', text }),
    signal: AbortSignal.timeout(5000),
  }).then(async r => {
    if (!r.ok) {
      await fetch(KURO_CHAT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text }),
        signal: AbortSignal.timeout(5000),
      });
    }
  }).catch(() => {
    const alertPath = join(agentDir, 'logs', 'escalations.jsonl');
    const entry = JSON.stringify({ ts: new Date().toISOString(), text });
    try { appendFileSync(alertPath, entry + '\n'); } catch { /* */ }
  });
}

export function parseJsonFromLLM<T>(result: string, fallback: T): T {
  try {
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    return jsonMatch ? JSON.parse(jsonMatch[0]) as T : fallback;
  } catch {
    return fallback;
  }
}

export function log(agentDir: string, tag: string, msg: string): void {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${tag}] ${msg}`;
  console.log(line);
  try {
    const logDir = join(agentDir, 'logs');
    if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
    writeFileSync(join(logDir, 'behavior.log'), line + '\n', { flag: 'a' });
  } catch { /* fire and forget */ }
}
