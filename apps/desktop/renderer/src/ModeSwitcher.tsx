import type { CodeMapMode } from './CodeMap';

type Mode = CodeMapMode;

/**
 * Every mode's visible label, in display order. `satisfies Record<Mode, …>`
 * makes adding a mode a compile error until it is listed here.
 */
export const MODE_SWITCHER_LABELS = {
  codeMap: 'Code Map',
  prReview: 'PR Review Mode',
  healthAudit: 'Health Audit Mode',
} as const satisfies Record<Mode, string>;

export const MODE_SWITCHER_OPTIONS = (Object.keys(MODE_SWITCHER_LABELS) as Mode[]).map((value) => ({
  value,
  label: MODE_SWITCHER_LABELS[value],
}));

export const MODE_SWITCHER_HINT_ID = 'mode-switcher-hint';

/**
 * Story 3.1 (Phase 2): the header mode switcher — mode is first-class state,
 * never a settings toggle (UX-DR9). A native radio group like
 * `.settings-panel__radio`, laid out inline; `role="radiogroup"`/`aria-label`
 * stands in for a `<fieldset>`/`<legend>` the header row has no room for,
 * matching CodeMap's `role="toolbar"` convention for inline control groups.
 * Health Audit became a real option in Story 4.1.
 *
 * P2-2: until a project is open it is disabled but never hidden, because the
 * first-open mode rule (new project → Health Audit, known → Code Map) would
 * overwrite any earlier pick. The radios use `aria-disabled`, not `disabled`,
 * so they stay focusable and a keyboard user hears the hint via
 * `aria-describedby`; `onChange` is a no-op and the controlled `checked` keeps
 * the selection unchanged. MUST STAY HOOKLESS: `ModeSwitcher.test.ts` calls it
 * directly.
 */
export function ModeSwitcher({
  mode,
  enabled,
  onChange,
}: {
  mode: Mode;
  enabled: boolean;
  onChange: (mode: Mode) => void;
}) {
  const describedBy = enabled ? undefined : MODE_SWITCHER_HINT_ID;
  return (
    <>
      <div
        className="mode-switcher"
        role="radiogroup"
        aria-label="View mode"
        aria-disabled={enabled ? undefined : true}
        aria-describedby={describedBy}
      >
        {MODE_SWITCHER_OPTIONS.map(({ value, label }) => (
          <label key={value} className="mode-switcher__option">
            <input
              type="radio"
              name="mode"
              value={value}
              checked={mode === value}
              aria-disabled={enabled ? undefined : true}
              aria-describedby={describedBy}
              onChange={() => {
                if (enabled) {
                  onChange(value);
                }
              }}
            />
            {label}
          </label>
        ))}
      </div>
      {!enabled && (
        <span id={MODE_SWITCHER_HINT_ID} className="mode-switcher__hint">
          Open a project to switch views
        </span>
      )}
    </>
  );
}
