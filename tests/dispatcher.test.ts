import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseTags } from '../src/dispatcher.js';

describe('parseTags', () => {
  it('parses single tag', () => {
    const actions = parseTags('<agent:action>did something</agent:action>');
    assert.equal(actions.length, 1);
    assert.equal(actions[0]!.tag, 'action');
    assert.equal(actions[0]!.content, 'did something');
  });

  it('parses multiple tags', () => {
    const response = [
      '<agent:action>checked status</agent:action>',
      '<agent:remember>important fact</agent:remember>',
      '<agent:chat>hello world</agent:chat>',
    ].join('\n');

    const actions = parseTags(response);
    assert.equal(actions.length, 3);
    assert.equal(actions[0]!.tag, 'action');
    assert.equal(actions[1]!.tag, 'remember');
    assert.equal(actions[2]!.tag, 'chat');
  });

  it('parses tag with attributes', () => {
    const actions = parseTags('<agent:remember topic="mushi">some insight</agent:remember>');
    assert.equal(actions.length, 1);
    assert.equal(actions[0]!.attrs.topic, 'mushi');
    assert.equal(actions[0]!.content, 'some insight');
  });

  it('parses self-closing tag', () => {
    const actions = parseTags('<agent:schedule next="5m" reason="waiting"/>');
    assert.equal(actions.length, 1);
    assert.equal(actions[0]!.tag, 'schedule');
    assert.equal(actions[0]!.attrs.next, '5m');
    assert.equal(actions[0]!.attrs.reason, 'waiting');
    assert.equal(actions[0]!.content, '');
  });

  it('handles multiline content', () => {
    const actions = parseTags('<agent:escalate>line 1\nline 2\nline 3</agent:escalate>');
    assert.equal(actions.length, 1);
    assert.ok(actions[0]!.content.includes('line 1'));
    assert.ok(actions[0]!.content.includes('line 3'));
  });

  it('trims whitespace from content', () => {
    const actions = parseTags('<agent:action>  spaced content  </agent:action>');
    assert.equal(actions[0]!.content, 'spaced content');
  });

  it('returns empty array for no tags', () => {
    assert.deepEqual(parseTags('just normal text, no tags'), []);
    assert.deepEqual(parseTags(''), []);
  });

  it('ignores non-agent tags', () => {
    const actions = parseTags('<div>not an agent tag</div><agent:action>real</agent:action>');
    assert.equal(actions.length, 1);
    assert.equal(actions[0]!.tag, 'action');
  });

  it('parses mixed regular and self-closing tags', () => {
    const response = [
      '<agent:action>did work</agent:action>',
      '<agent:schedule next="10m" reason="rest"/>',
      '<agent:remember>key insight</agent:remember>',
    ].join('\n');

    const actions = parseTags(response);
    assert.equal(actions.length, 3);
    // Regular tags parsed first, then self-closing
    const tags = actions.map(a => a.tag);
    assert.ok(tags.includes('action'));
    assert.ok(tags.includes('schedule'));
    assert.ok(tags.includes('remember'));
  });

  it('handles multiple attributes', () => {
    const actions = parseTags('<agent:remember topic="ai" priority="high">data</agent:remember>');
    assert.equal(actions[0]!.attrs.topic, 'ai');
    assert.equal(actions[0]!.attrs.priority, 'high');
  });
});
