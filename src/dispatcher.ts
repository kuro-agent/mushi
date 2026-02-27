/**
 * mushi — tag parser + action dispatcher
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentConfig, ParsedAction } from './types.js';
import { parseInterval, log } from './utils.js';

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
