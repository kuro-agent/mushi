import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { simpleHash, parseInterval, estimateTokens, truncateToTokens, parseJsonFromLLM } from '../src/utils.js';

describe('simpleHash', () => {
  it('returns consistent hash for same input', () => {
    assert.equal(simpleHash('hello'), simpleHash('hello'));
  });

  it('returns different hash for different input', () => {
    assert.notEqual(simpleHash('hello'), simpleHash('world'));
  });

  it('handles empty string', () => {
    assert.equal(simpleHash(''), '0');
  });

  it('handles unicode', () => {
    const h = simpleHash('こんにちは');
    assert.ok(typeof h === 'string' && h.length > 0);
  });
});

describe('parseInterval', () => {
  it('parses seconds', () => {
    assert.equal(parseInterval('30s'), 30_000);
  });

  it('parses minutes', () => {
    assert.equal(parseInterval('5m'), 300_000);
  });

  it('parses hours', () => {
    assert.equal(parseInterval('2h'), 7_200_000);
  });

  it('returns 60s default for invalid input', () => {
    assert.equal(parseInterval('invalid'), 60_000);
    assert.equal(parseInterval(''), 60_000);
    assert.equal(parseInterval('10x'), 60_000);
  });
});

describe('estimateTokens', () => {
  it('estimates roughly 1 token per 3.5 chars', () => {
    const text = 'a'.repeat(35);
    assert.equal(estimateTokens(text), 10);
  });

  it('rounds up', () => {
    assert.equal(estimateTokens('hi'), 1);
  });

  it('handles empty string', () => {
    assert.equal(estimateTokens(''), 0);
  });
});

describe('truncateToTokens', () => {
  it('returns full text when under limit', () => {
    assert.equal(truncateToTokens('short', 100), 'short');
  });

  it('truncates long text', () => {
    const long = 'a'.repeat(1000);
    const result = truncateToTokens(long, 10);
    assert.ok(result.length < 1000);
    assert.ok(result.endsWith('...(truncated)'));
  });
});

describe('parseJsonFromLLM', () => {
  it('extracts JSON from clean response', () => {
    const result = parseJsonFromLLM('{"action": "skip", "reason": "noise"}', {});
    assert.deepEqual(result, { action: 'skip', reason: 'noise' });
  });

  it('extracts JSON wrapped in text', () => {
    const result = parseJsonFromLLM(
      'Here is my analysis:\n{"action": "wake", "reason": "new task"}\nDone.',
      {},
    );
    assert.deepEqual(result, { action: 'wake', reason: 'new task' });
  });

  it('extracts JSON from markdown code block', () => {
    const result = parseJsonFromLLM(
      '```json\n{"isDuplicate": true, "similarity": 0.95}\n```',
      {},
    );
    assert.deepEqual(result, { isDuplicate: true, similarity: 0.95 });
  });

  it('returns fallback for non-JSON', () => {
    const fallback = { action: 'wake', reason: 'fallback' };
    const result = parseJsonFromLLM('no json here', fallback);
    assert.deepEqual(result, fallback);
  });

  it('returns fallback for malformed JSON', () => {
    const fallback = { error: true };
    const result = parseJsonFromLLM('{broken json!!!', fallback);
    assert.deepEqual(result, fallback);
  });
});
