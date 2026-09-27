/**
 * Project-path normalisation shared by every per-project store that must
 * treat two spellings of one folder as the same project: Recent Projects
 * (settings.ts) and, P4-2 phase 3c, the "Show types & modules" toggle
 * (ui-settings.ts). Free of Electron imports so it runs under `npm test`.
 */

/**
 * Normalizes a path for de-duplication purposes: strips a trailing
 * separator and case-folds it. Case-insensitive filesystems (macOS and
 * Windows defaults) would otherwise treat differently-cased or
 * trailing-slash variants of the same folder as distinct Recent Projects
 * entries.
 */
export function normalizePathForComparison(projectPath: string): string {
  return projectPath.replace(/[\\/]+$/, '').toLowerCase();
}
