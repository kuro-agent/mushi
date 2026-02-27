/**
 * mushi — tag parser + action dispatcher
 *
 * Escalation bridge: <agent:escalate> POSTs to mini-agent's chat room,
 * making mushi a perception outpost for Kuro.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentConfig, ParsedAction } from './types.js';
import { parseInterval, log } from './utils.js';

const KURO_ROOM_URL = 'http://localhost:3001/api/room';
const KURO_CHAT_URL = 'http://localhost:3001/chat';

export function parseTags(response: string): ParsedAction[] {
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

export function dispatch(
  actions: ParsedAction[],
  config: AgentConfig,
  agentDir: string,
): { nextInterval?: number } {
  let nextInterval: number | undefined;

  for (const action of actions) {
    switch (action.tag) {
      case 'action':
        log(agentDir, 'action', action.content);
        break;

      case 'remember': {
        const memDir = join(agentDir, config.memory.dir);
        const topic = action.attrs.topic;
        const targetFile = topic
          ? join(memDir, 'topics', `${topic}.md`)
          : join(memDir, 'MEMORY.md');

        const dir = topic ? join(memDir, 'topics') : memDir;
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

        writeFileSync(targetFile, '\n- ' + action.content + '\n', { flag: 'a' });
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
        const text = `[mushi] ${raw}`;
        log(agentDir, 'escalate', text);
        // Fire-and-forget: try room API, fallback to /chat inbox
        fetch(KURO_ROOM_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: 'mushi', text }),
          signal: AbortSignal.timeout(5000),
        }).then(async r => {
          if (r.ok) {
            log(agentDir, 'escalate', 'delivered to kuro (room)');
          } else {
            // Room API rejected (e.g. 'mushi' not in allowed senders) — use inbox
            const fb = await fetch(KURO_CHAT_URL, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ message: text }),
              signal: AbortSignal.timeout(5000),
            });
            log(agentDir, 'escalate', fb.ok ? 'delivered to kuro (inbox)' : `inbox failed: ${fb.status}`);
          }
        }).catch(() => {
          log(agentDir, 'escalate', 'kuro unreachable — logging locally');
          const alertPath = join(agentDir, 'logs', 'escalations.jsonl');
          const entry = JSON.stringify({ ts: new Date().toISOString(), text: action.content });
          try { writeFileSync(alertPath, entry + '\n', { flag: 'a' }); } catch { /* */ }
        });
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
