/**
 * P2-5: turns the Graph Service's `graphService:codeMap` reply into the
 * renderer-facing ok `CodeMapResult`, validating the two scope fields at the
 * main boundary. The worker message crosses a process boundary untyped at
 * runtime, so a non-finite `hiddenByScope` becomes 0 and a non-string-array
 * `appliedScope` becomes `[]` — "no scope", the empty map's honest default.
 * `replaced` names the fields that were substituted, so the caller logs once
 * per reply rather than once per field.
 */
import type { CodeMapResult, GraphServiceCodeMapMessage } from '@driller/ipc-contracts';

type CodeMapReply = Extract<GraphServiceCodeMapMessage, { type: 'graphService:codeMap' }>;
type OkCodeMapResult = Extract<CodeMapResult, { status: 'ok' }>;

export function toOkCodeMapResult(message: CodeMapReply): {
  result: OkCodeMapResult;
  replaced: ('hiddenByScope' | 'appliedScope')[];
} {
  const replaced: ('hiddenByScope' | 'appliedScope')[] = [];
  const rawHidden: unknown = message.hiddenByScope;
  let hiddenByScope = 0;
  if (typeof rawHidden === 'number' && Number.isFinite(rawHidden)) {
    hiddenByScope = rawHidden;
  } else {
    replaced.push('hiddenByScope');
  }
  const rawScope: unknown = message.appliedScope;
  let appliedScope: string[] = [];
  if (Array.isArray(rawScope) && rawScope.every((entry) => typeof entry === 'string')) {
    appliedScope = rawScope as string[];
  } else {
    replaced.push('appliedScope');
  }
  return {
    result: { status: 'ok', nodes: message.nodes, edges: message.edges, hiddenByScope, appliedScope },
    replaced,
  };
}
