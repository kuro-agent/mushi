/**
 * mushi — pure utility functions (no state, no side effects except logging)
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
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
