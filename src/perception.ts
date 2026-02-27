/**
 * mushi — perception system
 *
 * Each plugin is a shell script that outputs text.
 * Cache + hash-based change detection.
 */

import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import type { PerceptionPlugin, PerceptionSignal } from './types.js';
import { simpleHash, parseInterval, log } from './utils.js';

export function runPlugin(
  plugin: PerceptionPlugin,
  agentDir: string,
  cache: Map<string, PerceptionSignal>,
): PerceptionSignal {
  const cached = cache.get(plugin.name);
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
    log(agentDir, 'perception', `plugin ${plugin.name} failed`);
  }

  // Noise reduction: strip volatile patterns before hashing
  let hashContent = content;
  if (plugin.strip_pattern) {
    try {
      const re = new RegExp(plugin.strip_pattern, 'g');
      hashContent = content.replace(re, '');
    } catch { /* invalid regex, use raw */ }
  }

  const hash = simpleHash(hashContent);
  const changed = !cached || cached.hash !== hash;

  const signal: PerceptionSignal = {
    name: plugin.name,
    category: plugin.category,
    content,
    hash,
    changed,
    trigger: plugin.trigger ?? false,
    lastRun: now,
  };

  cache.set(plugin.name, signal);
  return signal;
}

export function perceive(
  plugins: PerceptionPlugin[],
  agentDir: string,
  cache: Map<string, PerceptionSignal>,
): PerceptionSignal[] {
  return plugins.map(p => runPlugin(p, agentDir, cache));
}
