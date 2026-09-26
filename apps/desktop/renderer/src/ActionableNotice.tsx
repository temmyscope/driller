/**
 * P1-7: the one Actionable Notice shape (EXPERIENCE.md: "three fixed parts,
 * no exceptions") — a per-tone glyph told apart by shape, never colour alone;
 * one specific sentence; and at most one next action. Styled by DESIGN.md's
 * `actionable-notice` token (`.actionable-notice` in `styles.css`): a 2px
 * left rule on `panel-alt`, `accent` for info/progress, amber for warning,
 * red for error.
 *
 * Screen readers get the tone as words — a visually hidden "Warning:" /
 * "Error:" prefix — since the glyph itself is `aria-hidden`.
 *
 * MUST STAY HOOKLESS: `ActionableNotice.test.ts` (and
 * `CodeMap.prReviewNotice.test.ts`) call it directly with no renderer.
 */
import type { ReactNode } from 'react';

export type ActionableNoticeTone = 'progress' | 'info' | 'warning' | 'error';

/**
 * The fixed glyph per tone. The warning sign carries U+FE0E (text
 * presentation) so it never renders as a colour emoji. None of these may
 * match a `DETERMINISTIC_SIGNAL_ICONS` value or `SEVERE_SIGNAL_GLYPH`
 * (CodeMap.tsx); `ActionableNotice.test.ts` pins that.
 */
export const ACTIONABLE_NOTICE_GLYPHS: Readonly<Record<ActionableNoticeTone, string>> = {
  progress: '↻',
  info: 'ⓘ',
  warning: '\u26A0\uFE0E',
  error: '✕',
};

/** The visually hidden spoken prefix per tone; `info` and `progress` get none. */
export const ACTIONABLE_NOTICE_SPOKEN_PREFIX: Readonly<Record<ActionableNoticeTone, string | null>> = {
  progress: null,
  info: null,
  warning: 'Warning:',
  error: 'Error:',
};

/**
 * The single optional next action (a button). Numbers are excluded: a stray
 * `0` from a `count && <button>` would otherwise render as a visible "0".
 */
export type ActionableNoticeAction = Exclude<ReactNode, number | bigint>;

export interface ActionableNoticeProps {
  tone: ActionableNoticeTone;
  /** The one sentence — inline (phrasing) content only; it renders inside a `<span>`. */
  children: ReactNode;
  /** The single optional next action. `undefined`, `null`, booleans and `''` mean none → no action slot. */
  action?: ActionableNoticeAction;
  /** The live-region role the call site already had, if any. */
  role?: 'status' | 'alert';
  /** An extra class on the root, for a call site's placement/density (e.g. Settings' PR-bot disclosure). The shape itself never changes. */
  className?: string;
}

/** Whether `action` is a real action; empty values (and a stray number) render no slot. */
function hasActionContent(action: ActionableNoticeAction | undefined): boolean {
  if (action === undefined || action === null || typeof action === 'boolean' || action === '') {
    return false;
  }
  return typeof action !== 'number' && typeof action !== 'bigint';
}

export function ActionableNotice({ tone, children, action, role, className }: ActionableNoticeProps) {
  const prefix = ACTIONABLE_NOTICE_SPOKEN_PREFIX[tone];
  return (
    <div
      className={`actionable-notice actionable-notice--${tone}${className ? ` ${className}` : ''}`}
      role={role}
    >
      <span className="actionable-notice__glyph" aria-hidden="true">
        {ACTIONABLE_NOTICE_GLYPHS[tone]}
      </span>
      <span className="actionable-notice__text">
        {prefix !== null && <span className="visually-hidden">{`${prefix} `}</span>}
        {children}
      </span>
      {hasActionContent(action) && <div className="actionable-notice__action">{action}</div>}
    </div>
  );
}
