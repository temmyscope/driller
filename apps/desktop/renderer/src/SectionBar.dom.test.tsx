/**
 * P5-g (founder 2.3): a Section bar tab's target is at least 24px tall
 * (WCAG 2.5.8). The real `styles.css` is loaded into the document and the
 * tab's CASCADED box parts are summed — padding, border and one line of its
 * font size — cascade only, never layout (domEnv's "never assert CSS layout
 * in jsdom" still holds). `line-height` is `normal` here; 1.2 × font-size is
 * the low end of `normal` for the UI fonts, so the sum is a floor. The
 * rendered height itself is measured in the e2e run (p4-4i).
 */
import './test/domEnv';
import { cleanupAfterEach } from './test/domEnv';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { render, screen } from '@testing-library/react';
import { SectionBar } from './SectionBar';

const injected: HTMLStyleElement[] = [];
afterEach(async () => {
  for (const style of injected.splice(0)) style.remove();
  await cleanupAfterEach();
});

function loadAppStylesheet(): void {
  const style = document.createElement('style');
  style.textContent = readFileSync(fileURLToPath(new URL('./styles.css', import.meta.url)), 'utf8');
  document.head.append(style);
  injected.push(style);
}

const px = (value: string): number => {
  assert.match(value, /^\d+(\.\d+)?px$/, value);
  return Number.parseFloat(value);
};

/** The tab's cascaded height floor: padding + border + one line at 1.2 × font-size (`line-height: normal`). */
function cascadedTabHeight(tab: Element): number {
  const style = getComputedStyle(tab);
  const lineHeight = style.lineHeight === '' || style.lineHeight === 'normal' ? 1.2 * px(style.fontSize) : px(style.lineHeight);
  const border = (side: 'top' | 'bottom') =>
    style.getPropertyValue(`border-${side}-style`) === 'none' || style.getPropertyValue(`border-${side}-style`) === ''
      ? 0
      : px(style.getPropertyValue(`border-${side}-width`));
  return px(style.paddingTop) + px(style.paddingBottom) + border('top') + border('bottom') + lineHeight;
}

describe('P5-g: Section bar tabs are 24px targets', () => {
  it('every tab, active or not, cascades to ≥ 24px tall (padding 6px 10px)', () => {
    loadAppStylesheet();
    render(
      <SectionBar
        sections={[
          { path: 'app/apps', nodeCount: 3 },
          { path: 'app/services', nodeCount: 4 },
        ]}
        section="app/apps"
        enabled
        onChange={() => {}}
      />,
    );
    const tabs = screen.getAllByRole('tab');
    assert.equal(tabs.length, 3);
    for (const tab of tabs) {
      const style = getComputedStyle(tab);
      assert.equal(style.paddingTop, '6px');
      assert.equal(style.paddingBottom, '6px');
      assert.equal(style.paddingLeft, '10px');
      assert.equal(style.fontSize, '9.5px', 'the font is unchanged');
      const height = cascadedTabHeight(tab);
      assert.ok(height >= 24, `${tab.textContent}: ${height}px`);
    }
  });
});
