import path from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  defaultProfileDir,
  findBrowserExecutable,
} from "./gmaps-playwright.mjs";

const browserPath = await findBrowserExecutable();
if (!browserPath) {
  throw new Error(
    "Could not find Chromium or Chrome. Set GMAPS_BROWSER_PATH to its executable."
  );
}

const profileDir = path.resolve(defaultProfileDir);
const browser = spawn(browserPath, [
  `--user-data-dir=${profileDir}`,
  "--new-window",
  "https://www.google.com/maps",
], {
  detached: true,
  stdio: "ignore",
});
browser.unref();

console.log(`Using dedicated browser profile: ${profileDir}`);
console.log(
  "Sign in to Google Maps in the opened browser, close that browser window, then press Enter here."
);

const rl = createInterface({ input, output });
await rl.question("");
rl.close();
