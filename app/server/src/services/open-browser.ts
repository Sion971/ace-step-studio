// services/open-browser.ts
//
// Opens the Studio in the user's browser as soon as the server listens, instead of when the engine is ready. At a first launch
// the engine downloads its models for many minutes (26 on a slow link, measured): opening the browser only at the end meant
// watching a terminal all that time, and the first-launch screen (components/SetupScreen.tsx) could not be seen.
//
// Same conditions as before: only when the Studio runs the engine itself, and not when NO_AUTO_BROWSER=true (the Pinokio
// launcher handles tab opening itself). It happens once, when the server starts, never on engine restarts.

import { exec } from 'child_process';

export function browserOpenCommand(url: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return `start "" "${url}"`;
  if (platform === 'darwin') return `open "${url}"`;
  return `xdg-open "${url}"`;
}

export interface OpenBrowserOptions {
  /** True when the Studio starts and runs the engine (MANAGE_PIPELINE=true). */
  managed: boolean;
  port: number;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  run?: (command: string) => void;
  log?: (message: string) => void;
}

/** Returns whether it tried to open the browser. Never throws. */
export function maybeOpenBrowser(options: OpenBrowserOptions): boolean {
  const {
    managed,
    port,
    env = process.env,
    platform = process.platform,
    run = (command: string) => {
      exec(command, () => {}); // a missing opener (headless server) must not crash the Studio
    },
    log = (message: string) => console.log(message),
  } = options;
  if (!managed || env.NO_AUTO_BROWSER === 'true') return false;
  const url = `http://localhost:${port}`;
  log(`[Server] Opening browser: ${url}`);
  try {
    run(browserOpenCommand(url, platform));
  } catch (error) {
    log(`[Server] Could not open the browser: ${(error as Error).message}`);
  }
  return true;
}
