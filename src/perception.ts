/**
 * mushi — perception system
 *
 * Each plugin is a shell script that outputs text.
 * Cache + hash-based change detection + signal classification.
 *
 * Three-level filtering (sensory gating):
 *   L0: Hash identical → no change
 *   L1: Hash changed but only numbers/counters differ → noise
 *   L1.5: Structural diff but no new meaningful content → low
 *   L2: Genuinely new content → signal (worth LLM call)
 */

import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import type { PerceptionPlugin, PerceptionSignal, SignalStrength } from './types.js';
import { simpleHash, parseInterval, log } from './utils.js';

/**
 * Classify the nature of a perception change.
 * Compares old and new content to determine if the change is meaningful.
 */
export function classifyChange(oldContent: string, newContent: string): SignalStrength {
  if (oldContent === newContent) return 'noise';

  // Strip all numbers and compare — if identical, only numbers changed
  const stripNumbers = (s: string) => s.replace(/\d+/g, '#');
  if (stripNumbers(oldContent) === stripNumbers(newContent)) {
    return 'noise';
  }

  // Line-level diff: find genuinely new lines
  const oldLines = new Set(
    oldContent.split('\n').map(l => l.trim()).filter(Boolean),
  );
  const newLines = newContent.split('\n').map(l => l.trim()).filter(Boolean);

  // Lines in new that don't exist in old
  const addedLines = newLines.filter(l => !oldLines.has(l));
  if (addedLines.length === 0) {
    return 'noise'; // No new lines at all
  }

  // Check if "new" lines are just number-variants of existing lines
  const oldLinesNormalized = new Set(
    [...oldLines].map(l => stripNumbers(l)),
  );
  const meaningfulAdded = addedLines.filter(l => {
    return !oldLinesNormalized.has(stripNumbers(l));
  });

  if (meaningfulAdded.length === 0) {
    return 'low'; // Lines changed but only numbers differ
  }

  return 'signal'; // Genuinely new content
}

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

  // Classify the change: noise vs low vs signal
  let signalStrength: SignalStrength = 'noise';
  if (changed && cached) {
    signalStrength = classifyChange(cached.content, content);
  } else if (changed && !cached) {
    signalStrength = 'signal'; // First run = always signal
  }

  const signal: PerceptionSignal = {
    name: plugin.name,
    category: plugin.category,
    content,
    hash,
    changed,
    trigger: plugin.trigger ?? false,
    signalStrength,
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
