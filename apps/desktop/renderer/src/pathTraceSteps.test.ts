/**
 * Path Trace's notice copy: what driller tells an engineer when a trace
 * comes back with nothing.
 *
 * The journey this guards is UJ-1's climax — an engineer runs a trace from a
 * change toward a sensitive boundary, gets nothing back, and approves. What
 * they are entitled to conclude from that depends entirely on what driller
 * searched, so the sentence has to say.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { pathTraceNotFoundText } from './pathTraceSteps';

describe('what an engineer is told when a Path Trace finds nothing', () => {
  it('says the search covered indexed code, never that no path exists', () => {
    const sentence = pathTraceNotFoundText(null);
    assert.match(sentence, /in indexed code/, `"${sentence}" must say what was searched`);
    assert.doesNotMatch(
      sentence,
      /\bno path exists\b|\bthere is no\b|\bnever reaches\b|\bproves\b/i,
      `"${sentence}" must not claim absence`,
    );
  });

  it('says the search was bounded to one section when a section is selected', () => {
    const scoped = pathTraceNotFoundText('api');
    assert.match(scoped, /in indexed code/);
    assert.match(scoped, /this section only/, `"${scoped}" must say the search was section-bounded`);
  });

  it('does not mention a section when the whole scope was searched', () => {
    assert.doesNotMatch(pathTraceNotFoundText(null), /section/i);
  });

  it('reads as one specific sentence, not an apology or a vague shrug', () => {
    for (const section of [null, 'api']) {
      const sentence = pathTraceNotFoundText(section);
      assert.match(sentence, /\.$/, 'ends as a sentence');
      assert.doesNotMatch(sentence, /sorry|oops|hmm|couldn't find anything|something went wrong/i);
      assert.equal(sentence.split('.').filter((part) => part.trim() !== '').length, 1, 'exactly one sentence');
    }
  });
});
