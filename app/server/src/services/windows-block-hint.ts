import path from 'path';

/**
 * On Windows, Smart App Control (or another code-integrity policy) refuses to load the unsigned Python
 * of the project's virtual environment: the engine cannot start and Node reports `spawn UNKNOWN`.
 * Returns the help to print next to that error, or null for any other failure.
 */
export function windowsBlockHint(err: unknown, folder: string, platform: string = process.platform): string | null {
  if (platform !== 'win32') return null;
  const e = err as { message?: unknown; code?: unknown } | null;
  const text = `${String(e?.code ?? '')} ${String(e?.message ?? '')}`;
  if (!/\bUNKNOWN\b/.test(text)) return null;
  const root = path.resolve(folder);
  return [
    '[Server] Windows refused to start the engine (spawn UNKNOWN).',
    '[Server] This is usually Smart App Control, or another code-integrity policy, blocking the unsigned Python of this folder.',
    '[Server] To confirm: Event Viewer > Applications and Services Logs > Microsoft > Windows > CodeIntegrity > Operational.',
    '[Server] Fix that keeps Smart App Control on: open PowerShell as administrator and run',
    `[Server]   Add-MpPreference -ExclusionPath "${root}"`,
    '[Server] then start run.bat again. (Turning Smart App Control off also works, but Windows usually cannot turn it back on without a reset.)',
  ].join('\n');
}
