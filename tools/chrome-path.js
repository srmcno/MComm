// chrome-path.js - find a Chromium the harnesses can actually launch.
//
// The tools used to hard-code /opt/pw-browsers/chromium-1194/..., which is one
// container image's build number. Anywhere else that path does not exist and
// every harness dies at launch with an unhelpful ENOENT.
//
// Order: CHROME_PATH / PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, then any chromium-*
// under PLAYWRIGHT_BROWSERS_PATH (newest build first), then playwright-core's
// own resolver, then the usual system locations.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SYSTEM = [
  '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];

// Playwright lays a build out differently on each platform.
const REL = [
  'chrome-linux/chrome',
  'chrome-linux/headless_shell',
  'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
  'chrome-win/chrome.exe',
];

function fromBrowsersDir(root) {
  if (!root || !existsSync(root)) return null;
  let dirs;
  try { dirs = readdirSync(root); } catch { return null; }
  const builds = dirs
    .filter((d) => /^chromium(_headless_shell)?[-_]/.test(d))
    // Newest build number wins, so a stale install never shadows a fresh one.
    .sort((a, b) => (parseInt(b.replace(/\D+/g, ''), 10) || 0) - (parseInt(a.replace(/\D+/g, ''), 10) || 0));
  for (const b of builds) {
    for (const rel of REL) {
      const p = join(root, b, rel);
      if (existsSync(p)) return p;
    }
  }
  // A directly-unpacked browser, no build-number wrapper.
  for (const rel of REL) {
    const p = join(root, rel);
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * @returns {string|undefined} an executable path, or undefined to let
 *   playwright-core pick for itself.
 */
export function chromePath() {
  for (const env of [process.env.CHROME_PATH, process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH]) {
    if (env && existsSync(env)) return env;
  }
  const found = fromBrowsersDir(process.env.PLAYWRIGHT_BROWSERS_PATH) ||
                fromBrowsersDir('/opt/pw-browsers') ||
                fromBrowsersDir(join(process.env.HOME || '', '.cache/ms-playwright'));
  if (found) return found;
  for (const p of SYSTEM) {
    try { if (existsSync(p) && statSync(p).isFile()) return p; } catch { /* keep looking */ }
  }
  return undefined;   // playwright-core resolves its own bundled browser
}

/** Launch options with executablePath omitted entirely when nothing was found. */
export function launchOpts(extra = {}) {
  const exe = chromePath();
  return exe ? { executablePath: exe, ...extra } : { ...extra };
}
