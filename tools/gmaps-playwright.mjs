import { access, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { chromium } from "playwright-core";

export const defaultProfileDir = ".playwright/google-profile";

const browserPaths = [
  process.env.GMAPS_BROWSER_PATH,
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter(Boolean);

export async function findBrowserExecutable() {
  for (const browserPath of browserPaths) {
    try {
      await access(browserPath, constants.X_OK);
      return browserPath;
    } catch {}
  }
  return null;
}

export async function launchMapsContext({ profileDir = defaultProfileDir } = {}) {
  await mkdir(profileDir, { recursive: true });

  const launchOptions = {
    headless: false,
    viewport: { width: 1440, height: 1000 },
  };

  if (process.env.GMAPS_BROWSER_CHANNEL) {
    launchOptions.channel = process.env.GMAPS_BROWSER_CHANNEL;
  } else {
    const executablePath = await findBrowserExecutable();
    if (executablePath) launchOptions.executablePath = executablePath;
  }

  return chromium.launchPersistentContext(profileDir, launchOptions);
}

export function normalizeMapsUrl(url) {
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  if (url.startsWith("/")) return `https://www.google.com${url}`;
  return `https://www.google.com/maps/search/${encodeURIComponent(url)}`;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
