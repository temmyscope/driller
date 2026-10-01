/**
 * P4-4 phase 1b: until P4-4d's Section bar, a Code Map fetch that comes back
 * `unknown-section` is shown as the map's error state, with a sentence that
 * names the section — never an empty map.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { codeMapFailureMessage } from './CodeMap';

describe('codeMapFailureMessage', () => {
  it('names the unknown section', () => {
    assert.equal(
      codeMapFailureMessage({ status: 'unknown-section', section: 'docs', knownSections: ['web', 'api'] }),
      'The section "docs" is not in this project\'s included subfolders.',
    );
  });

  it('passes an error message through', () => {
    assert.equal(codeMapFailureMessage({ status: 'error', message: 'Invalid section.' }), 'Invalid section.');
  });
});
