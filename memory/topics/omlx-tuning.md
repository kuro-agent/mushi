# oMLX + Qwen3.5-9B 校調方案

> 最後更新：2026-03-12

## 硬體環境

- Apple Silicon Mac（統一記憶體架構）
- oMLX v0.2.7（Homebrew 安裝）
- 模型：`Qwen3.5-9B-MLX-4bit`（mlx-community 量化版）

## oMLX 設定（`~/.omlx/settings.json`）

### 已調整的參數

| 參數 | 調整前 | 調整後 | 原因 |
|------|--------|--------|------|
| `cache.ssd_cache_dir` | `null` | `~/.omlx/cache` | 啟用 SSD KV cache — mushi 每次送類似 system prompt，prefix 復用免重算 |
| `cache.hot_cache_max_size` | `"0"` | `"20%"` | 記憶體 hot cache，頻繁存取的 KV blocks 保留在記憶體 |
| `scheduler.completion_batch_size` | `8` | `32` | 增加 token 生成批次大小，提升吞吐 |
| `sampling.top_p` | `0.95` | `1.0` | Qwen3.5 官方推薦 non-thinking text: top_p=1.0 |
| `sampling.top_k` | `0`（無限） | `20` | Qwen3.5 官方推薦 top_k=20 |

### 未動的參數

| 參數 | 值 | 說明 |
|------|------|------|
| `model.max_model_memory` | `12GB` | 9B-4bit 約需 6GB，12GB 留餘量 |
| `scheduler.max_num_seqs` | `8` | mushi 用 priority queue 序列化，實際並發低 |
| `sampling.temperature` | `1.0` | 符合 Qwen3.5 官方推薦 |
| `sampling.repetition_penalty` | `1.0` | 官方推薦值 |

## mushi 應用層設定（`agent.production.yaml`）

### Sampling 參數（per-request 覆寫）

```yaml
model:
  temperature: 1.0
  top_p: 1.0          # think mode 自動調整為 0.95
  top_k: 20
  presence_penalty: 2.0  # think mode 自動調整為 1.5（防重複輸出）
  max_tokens: 512     # non-think 回應上限
  think_max_tokens: 8192  # think mode 上限（thinking + response）
  think_timeout: 600000   # think mode 10 分鐘 timeout
```

### 各端點配置

| 端點 | 模式 | Priority | 說明 |
|------|------|----------|------|
| DM Triage | think | P0 (INTERACTIVE) | 人類訊息判斷 wake/skip |
| Classify | non-think | P1 (DECISION) | P0-P3 優先級分類 |
| Route | think | P1 (DECISION) | 路由決策 |
| Triage | non-think | P0 (INTERACTIVE) | 環境事件 wake/skip/quick |
| Internal Think | non-think + skipIfBusy | P2 (BACKGROUND) | queue busy 時跳過 |

## Qwen3.5 官方推薦 Sampling 參數

來源：[HuggingFace Qwen3.5 Model Card](https://huggingface.co/Qwen/Qwen3.5-0.8B)

### Non-Thinking Mode（Text）
```
temperature=1.0, top_p=1.0, top_k=20, min_p=0.0
presence_penalty=2.0, repetition_penalty=1.0
```

### Thinking Mode（Text）
```
temperature=1.0, top_p=0.95, top_k=20, min_p=0.0
presence_penalty=1.5, repetition_penalty=1.0
```

### 注意事項
- 小模型（≤9B）**預設關閉 Thinking** — 需要 `chat_template_kwargs: { enable_thinking: true }` 明確開啟
- `presence_penalty` 防止無限重複輸出（特別重要，曾導致 non-think 也跑 90 秒）
- Think mode 的 `top_p=0.95`（而非 1.0）讓推理更聚焦

## Priority Model Queue

mushi 內建 priority queue（`src/model.ts`）序列化 oMLX 存取：

- **P0 INTERACTIVE**：人類訊息，最高優先
- **P1 DECISION**：classify、route，cycle-critical
- **P2 BACKGROUND**：internal think，最低優先
- `tryEnqueue`：P2 請求在 queue busy 時直接跳過（防堆積）
- 所有請求排隊等待 single GPU，按優先級排序

## 效能基線（調整前）

- 222 次請求 / 4184 秒 generation = 平均 18.8 秒/請求
- ~12.2 tok/s（Qwen3.5-9B-MLX-4bit）
- `cached_tokens: 0`（SSD cache 未啟用）

## 未來優化方向

1. **對比 MLX-8bit vs MLX-4bit**：記憶體夠的話，8bit 精度更高
2. **Qwen3.5-35B-A3B（MoE）**：active 只有 3B params，速度接近 9B 但能力更強
3. **Unsloth 微調**：用累積的 triage/classify 歷史資料微調專屬分類模型
4. **monitor SSD cache hit rate**：確認 prefix 復用生效
