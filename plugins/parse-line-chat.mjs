#!/usr/bin/env node
// parse-line-chat.mjs — Parse LINE Chrome Extension CDP extract into chronological messages
// Usage: echo "$CONTENT" | node parse-line-chat.mjs [--merge existing.log]
// Output: Clean chronological chat log to stdout
//
// Message format in LINE extract: [Sender][Content][Timestamp]‌ (newest first)
// Date markers: 今天, 昨天, N月N日(週X) appear inline between messages

import { readFileSync, existsSync } from 'fs';
import { createHash } from 'crypto';

const args = process.argv.slice(2);
const mergeFile = args.includes('--merge') ? args[args.indexOf('--merge') + 1] : null;

const raw = readFileSync(0, 'utf8');

// --- Step 1: Extract chat section ---
const chatMarker = '聊天室群組';
const chatIdx = raw.indexOf(chatMarker);
if (chatIdx === -1) {
  process.exit(0);
}

let text = raw.substring(chatIdx);

// Remove Links section
const linksIdx = text.indexOf('--- Links ---');
if (linksIdx !== -1) text = text.substring(0, linksIdx);

// Extract group name from header (e.g., "聊天室群組Claude MAX 俱樂部(271)")
// Group name always ends with (N) member count
const groupMatch = text.match(/^聊天室群組(.+?\(\d+\))/);
const groupName = groupMatch ? groupMatch[1].trim() : 'LINE Chat';

// Remove header: group name + optional "跳至先前的訊息"
text = text.replace(/^聊天室群組.+?\(\d+\)(?:跳至先前的訊息)?/, '');

// Remove "以下為尚未閱讀的訊息" markers
text = text.replace(/以下為尚未閱讀的訊息/g, '');

// --- Step 2: Pre-scan for true date markers ---
// LINE date separators are standalone DOM elements. In the flattened text,
// true date markers are always preceded by ‌ (ZWNJ = message boundary).
// False positives like "美股今天被血洗" lack the ZWNJ prefix.
const dateMarkerRe = /‌(今天|昨天|(\d+)月(\d+)日(?:\(週[一二三四五六日]\))?)/g;
const dateMarkerPositions = []; // { index, date }
let dm;
while ((dm = dateMarkerRe.exec(text)) !== null) {
  let date;
  if (dm[1] === '今天') {
    date = todayStr();
  } else if (dm[1] === '昨天') {
    date = offsetDateStr(-1);
  } else {
    const month = dm[2].padStart(2, '0');
    const day = dm[3].padStart(2, '0');
    date = `${new Date().getFullYear()}-${month}-${day}`;
  }
  dateMarkerPositions.push({ index: dm.index, endIndex: dm.index + dm[0].length, date });
  // Remove the date marker text so it doesn't pollute message content
  text = text.substring(0, dm.index) + ' '.repeat(dm[0].length) + text.substring(dm.index + dm[0].length);
  dateMarkerRe.lastIndex = dm.index + dm[0].length;
}

// Parse messages
// Timestamp pattern: (上午|下午) H:MM
const timeRe = /(上午|下午)\s*(\d{1,2}):(\d{2})/g;

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function offsetDateStr(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function to24h(period, hour, minute) {
  let h = parseInt(hour);
  if (period === '下午' && h !== 12) h += 12;
  if (period === '上午' && h === 12) h = 0;
  return `${String(h).padStart(2, '0')}:${minute}`;
}

function hashStr(s) {
  return createHash('md5').update(s).digest('hex').slice(0, 12);
}

// Find all timestamp positions
const timestamps = [];
let match;
while ((match = timeRe.exec(text)) !== null) {
  timestamps.push({
    index: match.index,
    length: match[0].length,
    time24: to24h(match[1], match[2], match[3]),
    original: match[0]
  });
}

if (timestamps.length === 0) {
  process.exit(0);
}

// Messages are delimited by timestamps. Pattern: [content][timestamp]‌
// So text BEFORE each timestamp belongs to that message.
// Extraction order is newest-first. Date markers (pre-scanned above)
// appear between date sections in the extraction flow.
let currentDate = todayStr();
const messages = [];
const seen = new Set();

// In column-reverse DOM, text flows newest→oldest. Date markers appear
// AFTER the messages they label: [today msgs] ‌今天‌ [yesterday msgs] ‌昨天‌ ...
// So messages BEFORE marker[i] belong to marker[i].date,
// and messages BETWEEN marker[i] and marker[i+1] belong to marker[i+1].date.
function getDateForPosition(pos) {
  if (dateMarkerPositions.length === 0) return todayStr();
  // Before first marker → first marker's date (newest section)
  if (pos < dateMarkerPositions[0].index) return dateMarkerPositions[0].date;
  // Between marker[i] and marker[i+1] → next marker's date
  for (let j = 0; j < dateMarkerPositions.length - 1; j++) {
    if (pos >= dateMarkerPositions[j].endIndex && pos < dateMarkerPositions[j + 1].index) {
      return dateMarkerPositions[j + 1].date;
    }
  }
  // After last marker → last marker's date
  return dateMarkerPositions[dateMarkerPositions.length - 1].date;
}

for (let i = 0; i < timestamps.length; i++) {
  const ts = timestamps[i];
  const prevTs = timestamps[i - 1];

  // Determine date from position relative to date markers
  currentDate = getDateForPosition(ts.index);

  // Message content is between previous timestamp's end and this timestamp's start
  const contentStart = prevTs ? prevTs.index + prevTs.length : 0;
  let content = text.substring(contentStart, ts.index);

  // Clean ZWNJ and whitespace
  content = content.replace(/‌/g, ' ').trim();

  // Clean up: replace image placeholder text
  content = content.replace(/儲存另存新檔分享/g, '[圖片]');

  // Skip empty messages (stickers, system artifacts)
  if (content.length < 1) continue;

  // Dedup by content hash
  const hash = hashStr(content + ts.time24);
  if (seen.has(hash)) continue;
  seen.add(hash);

  messages.push({
    date: currentDate,
    time: ts.time24,
    sortKey: `${currentDate}T${ts.time24}:${String(i).padStart(4, '0')}`,
    content,
    hash
  });
}

// --- Step 3: Merge with existing log ---
// Handle multi-line messages: a message starts with [HH:MM] and continues
// until the next [HH:MM], date header, or end of file.
if (mergeFile && existsSync(mergeFile)) {
  const existing = readFileSync(mergeFile, 'utf8');
  const msgStartRe = /^\[(\d{2}:\d{2})\] /;
  let existingDate = todayStr();
  let currentMsg = null; // { time, lines[] }

  const flushMsg = () => {
    if (!currentMsg) return;
    const content = currentMsg.lines.join('\n');
    const hash = hashStr(content + currentMsg.time);
    if (!seen.has(hash)) {
      seen.add(hash);
      messages.push({
        date: currentMsg.date,
        time: currentMsg.time,
        sortKey: `${currentMsg.date}T${currentMsg.time}:9999`,
        content,
        hash
      });
    }
    currentMsg = null;
  };

  for (const line of existing.split('\n')) {
    // Date header: === YYYY-MM-DD ===
    const dateHeader = line.match(/^=== (\d{4}-\d{2}-\d{2}) ===$/);
    if (dateHeader) {
      flushMsg();
      existingDate = dateHeader[1];
      continue;
    }

    // Skip comment/header lines
    if (line.startsWith('#') || line.trim() === '') {
      flushMsg();
      continue;
    }

    // New message starts with [HH:MM]
    const msgStart = line.match(msgStartRe);
    if (msgStart) {
      flushMsg();
      const content = line.substring(msgStart[0].length);
      currentMsg = { time: msgStart[1], date: existingDate, lines: [content] };
    } else if (currentMsg) {
      // Continuation of multi-line message
      currentMsg.lines.push(line);
    }
  }
  flushMsg();
}

// --- Step 4: Sort and final dedup ---
// Sort chronologically
messages.sort((a, b) => a.sortKey.localeCompare(b.sortKey));

// Final dedup pass: LINE quoted replies duplicate the original message text.
// Two messages with the same time and similar content (first 80 chars) are duplicates.
const finalMessages = [];
const dedupKeys = new Set();
for (const msg of messages) {
  const key = `${msg.date}|${msg.time}|${msg.content.substring(0, 80)}`;
  if (dedupKeys.has(key)) continue;
  dedupKeys.add(key);
  finalMessages.push(msg);
}

// --- Step 5: Output ---
let lastDate = '';
if (messages.length > 0) {
  console.log(`# ${groupName}`);
  console.log(`# Last synced: ${new Date().toLocaleTimeString('en-GB')}`);
  console.log('');
}

for (const msg of finalMessages) {
  if (msg.date !== lastDate) {
    if (lastDate) console.log('');
    console.log(`=== ${msg.date} ===`);
    lastDate = msg.date;
  }
  console.log(`[${msg.time}] ${msg.content}`);
}
