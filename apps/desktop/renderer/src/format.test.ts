/**
 * The shared count formatter (P2-3, moved to `format.ts` by FIX-3).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { formatCount, formatCountNumber, formatMapCounts } from './format';

describe('formatCountNumber', () => {
  it('uses an en-US thousands separator', () => {
    assert.equal(formatCountNumber(0), '0');
    assert.equal(formatCountNumber(999), '999');
    assert.equal(formatCountNumber(1014), '1,014');
    assert.equal(formatCountNumber(1_234_567), '1,234,567');
  });

  it('renders "—" for a count that cannot be one', () => {
    for (const bad of [-1, -0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      assert.equal(formatCountNumber(bad), '—', String(bad));
    }
  });
});

describe('formatCount', () => {
  it('pairs the number with the singular or plural noun', () => {
    assert.equal(formatCount(1, 'Node', 'Nodes'), '1 Node');
    assert.equal(formatCount(0, 'Node', 'Nodes'), '0 Nodes');
    assert.equal(formatCount(1014, 'Node', 'Nodes'), '1,014 Nodes');
    assert.equal(formatCount(Number.NaN, 'Node', 'Nodes'), '— Nodes');
    assert.equal(formatCount(-3, 'Node', 'Nodes'), '— Nodes');
  });
});

describe('formatMapCounts', () => {
  it('singular forms', () => {
    assert.equal(formatMapCounts(1, 1), '1 Node · 1 edge');
  });

  it('thousands separators', () => {
    assert.equal(formatMapCounts(10000, 12345), '10,000 Nodes · 12,345 edges');
  });
});
