#!/bin/bash
# line-sync.sh — Sync LINE Chrome Extension chat to clean chronological daily logs
# Parses messages, deduplicates, merges with existing log, sorts by time.
#
# Storage: ~/.mini-agent/line-sync/
#   YYYY-MM-DD.log    — clean chronological chat log (merged across syncs)
#   .last-hash        — dedup hash (skip if content unchanged)

CDP_FETCH="/Users/user/Workspace/mini-agent/scripts/cdp-fetch.mjs"
PARSER="$(dirname "$0")/parse-line-chat.mjs"
SYNC_DIR="$HOME/.mini-agent/line-sync"
HASH_FILE="$SYNC_DIR/.last-hash"
MAX_AGE_DAYS=30

# Find LINE Chrome Extension tab
TAB_ID=$(curl -sf http://localhost:9222/json/list 2>/dev/null \
  | jq -r '.[] | select(.url | startswith("chrome-extension://ophjlpahpchlmihnnnihgmmeilfjmjjc/index.html#/chats/")) | .id' \
  | head -1)

if [ -z "$TAB_ID" ]; then
  echo "Status: no LINE chat tab"
  exit 0
fi

# Extract content via CDP eval — walk DOM structure for clean separation
# LINE DOM: message-module (normal), replyMessage-module (reply), systemMessage-module (system)
# Each message has: pre.username (sender), span[data-is-message-text] (content), div.metaInfo (time)
# Reply messages additionally have: button.button_move or div.origin_content (quoted message)
CONTENT=$(node "$CDP_FETCH" eval "$TAB_ID" '
var ml = document.querySelector(".message_list");
if (!ml) "";
var h = "";
document.querySelectorAll("button").forEach(function(b) {
  if (!h && b.textContent.match(/\(\d+\)/)) h = b.textContent;
});
var out = "聊天室群組" + h;
var ch = ml.children;
for (var i = 0; i < ch.length; i++) {
  var el = ch[i];
  var cls = el.className;
  if (cls.includes("messageDate")) {
    var t = el.querySelector("time");
    out += "\u200c" + (t ? t.textContent.trim() : el.textContent.trim()) + "\u200c";
    continue;
  }
  if (cls.includes("systemMessage")) {
    var t = el.querySelector("time");
    var s = el.querySelector("span");
    if (!t && !s) continue;
    var timeText = t ? t.textContent.trim() : "";
    var msgText = s ? s.textContent.trim() : "";
    if (!msgText || msgText.includes("以下為尚未閱讀")) continue;
    out += "\u200c" + msgText + "\n" + timeText + "\u200c";
    continue;
  }
  if (!cls.includes("message-module")) continue;
  var u = el.querySelector("pre[class*=username]");
  var m = el.querySelector("div[class*=metaInfo]");
  var sender = u ? u.textContent.trim() : "";
  var time = m ? m.textContent.trim().replace(/已讀\s*\d+/, "").trim() : "";
  var parts = [sender];
  if (cls.includes("replyMessage")) {
    var qBtn = el.querySelector("button[class*=button_move]");
    var qOrig = el.querySelector("div[class*=origin_content]");
    var qContainer = qBtn || qOrig;
    if (qContainer) {
      var qU = qContainer.querySelector("pre[class*=username]");
      var qT = qContainer.querySelector("p[class*=text]") || qContainer.querySelector("span[data-is-message-text]");
      var qAuthor = qU ? qU.textContent.trim() : "";
      var qText = qT ? qT.textContent.trim() : "";
      if (qText) parts.push(">" + (qAuthor ? qAuthor + " " : "") + qText);
    }
    var rc = el.querySelector("div[class*=reply_content]");
    if (rc) {
      var rt = rc.querySelector("span[data-is-message-text]");
      parts.push(rt ? rt.textContent.trim() : "");
    }
  } else {
    var txt = el.querySelector("span[data-is-message-text]");
    if (txt) {
      parts.push(txt.textContent.trim());
    } else {
      var hasStkr = el.querySelector("div[class*=stickerMessageContent]");
      var hasImg = el.querySelector("div[class*=imageMessageContent]");
      parts.push(hasStkr ? "[貼圖]" : hasImg ? "[圖片]" : "");
    }
  }
  parts.push(time);
  out += "\u200c" + parts.filter(function(p){return p;}).join("\n") + "\u200c";
}
out;
' 2>/dev/null)

if [ -z "$CONTENT" ] || [ ${#CONTENT} -lt 100 ]; then
  echo "Status: extraction failed"
  exit 0
fi

# Dedup by content hash
HASH=$(echo "$CONTENT" | md5 -q 2>/dev/null || echo "$CONTENT" | md5sum | cut -d' ' -f1)
LAST_HASH=$(cat "$HASH_FILE" 2>/dev/null)

if [ "$HASH" = "$LAST_HASH" ]; then
  echo "Status: unchanged"
  exit 0
fi

mkdir -p "$SYNC_DIR"

DATE=$(date +%Y-%m-%d)
LOG_FILE="$SYNC_DIR/${DATE}.log"

# Parse content into chronological messages, merge with existing log
MERGE_OPT=""
if [ -f "$LOG_FILE" ]; then
  MERGE_OPT="--merge $LOG_FILE"
fi

PARSED=$(echo "$CONTENT" | node "$PARSER" $MERGE_OPT 2>/dev/null)

if [ -z "$PARSED" ]; then
  echo "Status: parse failed"
  exit 0
fi

# Write clean chronological log (atomic overwrite)
echo "$PARSED" > "$LOG_FILE"
echo "$HASH" > "$HASH_FILE"

# Cleanup old logs (>30 days) and legacy files
find "$SYNC_DIR" -name "*.log" -mtime +"$MAX_AGE_DAYS" -delete 2>/dev/null
rm -f "$SYNC_DIR/.last-content" 2>/dev/null
for f in "$SYNC_DIR"/*_*.txt; do [ -f "$f" ] && rm "$f"; done

# Stats
LOG_SIZE=$(wc -c < "$LOG_FILE" 2>/dev/null | tr -d ' ')
MSG_COUNT=$(grep -c '^\[' "$LOG_FILE" 2>/dev/null || echo 0)
GROUP=$(head -1 "$LOG_FILE" | sed 's/^# //')

echo "Status: synced ($MSG_COUNT messages)"
echo "Chat: ${GROUP:-unknown}"
echo "Log: ${DATE}.log (${LOG_SIZE} bytes)"
