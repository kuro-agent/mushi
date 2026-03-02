/**
 * room-watcher — SSE client that monitors mini-agent Chat Room
 * and triggers consensus detection when discussion patterns emerge.
 *
 * Architecture:
 *   SSE(/api/room/stream) → message buffer → trigger heuristic → callModel → POST /api/room
 */

import type { ModelConfig } from './types.js';
import { callModel } from './model.js';
import { log, parseJsonFromLLM } from './utils.js';

// ─── Config ─────────────────────────────────────────────

const KURO_BASE = 'http://localhost:3001';
const SSE_URL = `${KURO_BASE}/api/room/stream`;
const ROOM_API = `${KURO_BASE}/api/room`;

const TRIGGER_WINDOW_MS = 5 * 60_000;   // 5 min window
const MIN_MESSAGES = 3;                   // minimum messages to trigger
const MIN_PARTICIPANTS = 2;               // minimum distinct participants
const COOLDOWN_MS = 10 * 60_000;          // 10 min between triggers
const RECONNECT_DELAY_MS = 10_000;        // reconnect after disconnect
const MAX_BUFFER = 20;                    // max buffered messages

// ─── Types ──────────────────────────────────────────────

interface RoomMessage {
  from: string;
  text: string;
  ts: number;
}

// ─── State ──────────────────────────────────────────────

const messageBuffer: RoomMessage[] = [];
let lastTriggerAt = 0;
let connected = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

// ─── SSE Client ─────────────────────────────────────────

function connectSSE(modelConfig: ModelConfig, agentDir: string): void {
  if (connected) return;

  log(agentDir, 'room-watcher', `connecting to ${SSE_URL}`);

  fetch(SSE_URL, {
    headers: { 'Accept': 'text/event-stream' },
    // No signal — SSE is a long-lived connection
  }).then(async (response) => {
    if (!response.ok || !response.body) {
      log(agentDir, 'room-watcher', `SSE failed: ${response.status}`);
      scheduleReconnect(modelConfig, agentDir);
      return;
    }

    connected = true;
    log(agentDir, 'room-watcher', 'SSE connected');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            handleSSEData(line.slice(6), modelConfig, agentDir);
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      if (!msg.includes('abort')) {
        log(agentDir, 'room-watcher', `SSE read error: ${msg}`);
      }
    }

    connected = false;
    log(agentDir, 'room-watcher', 'SSE disconnected');
    scheduleReconnect(modelConfig, agentDir);
  }).catch((err) => {
    const msg = err instanceof Error ? err.message : 'unknown';
    log(agentDir, 'room-watcher', `SSE connect failed: ${msg}`);
    connected = false;
    scheduleReconnect(modelConfig, agentDir);
  });
}

function scheduleReconnect(modelConfig: ModelConfig, agentDir: string): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectSSE(modelConfig, agentDir);
  }, RECONNECT_DELAY_MS);
}

// ─── SSE Event Handler ─────────────────────────────────

function handleSSEData(data: string, modelConfig: ModelConfig, agentDir: string): void {
  try {
    const event = JSON.parse(data) as Record<string, unknown>;

    // action:room = new message posted to chat room
    // action:chat = Kuro's response
    if (event.type !== 'action:room' && event.type !== 'action:chat') return;

    const payload = event.payload as Record<string, unknown> | undefined;
    if (!payload) return;

    const from = (payload.from as string) ?? 'unknown';
    const text = (payload.text as string) ?? '';

    // Skip mushi's own messages to prevent feedback loop
    if (from === 'mushi') return;
    // Skip empty messages
    if (!text.trim()) return;

    const msg: RoomMessage = { from, text, ts: Date.now() };
    messageBuffer.push(msg);

    // Trim buffer
    while (messageBuffer.length > MAX_BUFFER) {
      messageBuffer.shift();
    }

    // Check trigger
    checkTrigger(modelConfig, agentDir);
  } catch {
    // malformed SSE data — ignore
  }
}

// ─── Trigger Heuristic ─────────────────────────────────

function checkTrigger(modelConfig: ModelConfig, agentDir: string): void {
  // Cooldown check
  if (Date.now() - lastTriggerAt < COOLDOWN_MS) return;

  const now = Date.now();
  const recent = messageBuffer.filter(m => now - m.ts < TRIGGER_WINDOW_MS);

  // Need enough messages
  if (recent.length < MIN_MESSAGES) return;

  // Need enough participants
  const participants = new Set(recent.map(m => m.from));
  if (participants.size < MIN_PARTICIPANTS) return;

  // Need alternating pattern (not monologue)
  let alternations = 0;
  for (let i = 1; i < recent.length; i++) {
    if (recent[i]!.from !== recent[i - 1]!.from) alternations++;
  }
  if (alternations < 2) return;

  // Trigger!
  lastTriggerAt = Date.now();
  log(agentDir, 'room-watcher', `triggered: ${recent.length} msgs, ${participants.size} people, ${alternations} alternations`);

  // Fire and forget — don't block SSE processing
  analyzeAndPost(recent, modelConfig, agentDir).catch((err) => {
    const msg = err instanceof Error ? err.message : 'unknown';
    log(agentDir, 'room-watcher', `analysis failed: ${msg}`);
  });
}

// ─── Consensus Analysis ────────────────────────────────

async function analyzeAndPost(
  messages: RoomMessage[],
  modelConfig: ModelConfig,
  agentDir: string,
): Promise<void> {
  const dialogue = messages
    .map(m => `[${m.from}]: ${m.text.slice(0, 300)}`)
    .join('\n\n');

  const systemPrompt = [
    'You are a discussion facilitator observing a team chat between Alex (human), Kuro (AI agent), and Claude Code (AI dev tool).',
    'Analyze the conversation and determine:',
    '1. Has consensus formed that nobody has explicitly acknowledged?',
    '2. Is the discussion drifting from the original topic?',
    '3. Is there a clear next action that nobody has committed to?',
    '',
    'Respond in EXACTLY this JSON format:',
    '{"status": "converged|drifting|stalled|healthy", "observation": "one sentence", "suggestion": "one actionable sentence or null"}',
    '',
    'Rules:',
    '- "healthy" = productive discussion, no intervention needed',
    '- Only suggest intervention for converged/drifting/stalled',
    '- Be concise. Under 50 words total.',
    '- If healthy, suggestion should be null',
  ].join('\n');

  const start = Date.now();
  const result = await callModel(modelConfig, agentDir, systemPrompt, dialogue);
  const latencyMs = Date.now() - start;

  // Parse response
  const parsed = parseJsonFromLLM<{ status?: string; observation?: string; suggestion?: string | null }>(
    result,
    { status: 'unknown', observation: result.slice(0, 200) },
  );

  log(agentDir, 'room-watcher', `analysis: ${parsed.status} (${latencyMs}ms)`);

  // Only post to room if intervention is warranted
  if (parsed.status === 'healthy' || !parsed.suggestion) {
    log(agentDir, 'room-watcher', 'healthy discussion — no intervention');
    return;
  }

  // Post observation to Chat Room
  const emoji = parsed.status === 'converged' ? '🤝'
    : parsed.status === 'drifting' ? '🔀'
    : parsed.status === 'stalled' ? '⏸️'
    : '💬';

  const text = `${emoji} ${parsed.observation}\n\n${parsed.suggestion}`;

  await fetch(ROOM_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'mushi', text }),
    signal: AbortSignal.timeout(5000),
  });

  log(agentDir, 'room-watcher', `posted to room: ${parsed.status}`);
}

// ─── Public API ─────────────────────────────────────────

export function startRoomWatcher(modelConfig: ModelConfig, agentDir: string): void {
  connectSSE(modelConfig, agentDir);
}

export function getRoomWatcherStatus(): {
  connected: boolean;
  buffered: number;
  lastTriggerAt: number;
  cooldownRemaining: number;
} {
  const remaining = Math.max(0, COOLDOWN_MS - (Date.now() - lastTriggerAt));
  return {
    connected,
    buffered: messageBuffer.length,
    lastTriggerAt,
    cooldownRemaining: remaining,
  };
}
