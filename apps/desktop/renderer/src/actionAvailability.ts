/**
 * What a control says and looks like when the Graph Service is not live.
 *
 * Shared because the same two strings gate controls on three surfaces — the
 * Path Trace search row, PR Review's "changed elsewhere" switch, and Node
 * detail's "Calls into other sections" — and every one of them must explain
 * the same way why it is disabled. A second copy of either would let two
 * disabled buttons give different reasons for the same cause.
 *
 * `sectionSwitchButtonProps` lives here with them because that is exactly
 * what it applies: a section-switch button is disabled, titled and
 * hint-linked by whether the service is live.
 */
/** P0-3: the `title` every Graph-Service-backed action carries while it's disabled for not being live. */
export const GRAPH_SERVICE_UNAVAILABLE_TITLE =
  'Unavailable while the Graph Service is not live — the map shows the last completed index.';

/**
 * P0-3: marks a button disabled because the Graph Service is down, not merely
 * busy ("Computing…"/"Searching…"/"Regenerating…") — styles.css gives only
 * these `cursor: not-allowed`.
 */
export const SERVICE_UNAVAILABLE_CLASS = 'code-map__action--service-unavailable';

/**
 * P4-4 review round 1: a cross-section switch button's availability props.
 * Never natively `disabled` while the session isn't live: `aria-disabled`
 * keeps it focusable and describes it by the Section bar's hint
 * (`SECTION_SWITCH_UNAVAILABLE_HINT`), and activating it does nothing — the
 * Section bar's own precedent.
 */
export function sectionSwitchButtonProps(
  graphServiceAvailable: boolean,
  hintId: string,
  onActivate: () => void,
): {
  className: string;
  'aria-disabled'?: true;
  'aria-describedby'?: string;
  onClick: () => void;
} {
  return graphServiceAvailable
    ? { className: 'code-map__link-button', onClick: onActivate }
    : {
        className: `code-map__link-button ${SERVICE_UNAVAILABLE_CLASS}`,
        'aria-disabled': true,
        'aria-describedby': hintId,
        onClick: () => {},
      };
}
