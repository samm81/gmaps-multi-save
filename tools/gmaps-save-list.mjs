import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "csv-parse/sync";
import getopts from "getopts";
import {
  launchMapsContext,
  normalizeMapsUrl,
  sleep,
} from "./gmaps-playwright.mjs";

const checkpointDefault = ".playwright/gmaps-save-checkpoint.json";
const screenshotDir = "output/playwright";

function usage() {
  return [
    "usage: npm run gmaps:save-list -- places.csv [--list-name name] [--limit 20]",
    "       [--checkpoint path] [--continue-on-error] [--delay-ms 2500]",
    "       [--max-distance-m 1000] [--retry-failed] [--dry-run]",
    "",
    "CSV columns: name,url,note,listName; optional source metadata: address,location,latitude,longitude",
    "Rows with source coordinates are verified before they are saved.",
    "Rerunning the same command skips rows already attempted; use --retry-failed to retry failures.",
    "Run `npm run gmaps:login` first to create the local Google session.",
  ].join("\n");
}

async function readCheckpoint(checkpointFile) {
  let contents;
  try {
    contents = await readFile(checkpointFile, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { completed: [], attempts: [] };
    throw error;
  }

  const checkpoint = JSON.parse(contents);
  if (!checkpoint || typeof checkpoint !== "object") {
    throw new Error(`checkpoint is not an object: ${checkpointFile}`);
  }

  return {
    ...checkpoint,
    completed: Array.isArray(checkpoint.completed) ? checkpoint.completed : [],
    attempts: Array.isArray(checkpoint.attempts) ? checkpoint.attempts : [],
  };
}

async function writeCheckpoint(checkpointFile, checkpoint) {
  await mkdir(path.dirname(checkpointFile), { recursive: true });
  const temporaryFile = `${checkpointFile}.tmp`;
  await writeFile(temporaryFile, `${JSON.stringify(checkpoint, null, 2)}\n`);
  await rename(temporaryFile, checkpointFile);
}

function placeKey({ name, url, listName }) {
  return `${listName}\t${name}\t${url}`;
}

function recordAttempt(checkpoint, row, status, details = {}) {
  checkpoint.attempts.push({
    key: placeKey(row),
    listName: row.listName,
    name: row.name,
    url: row.url,
    address: row.address,
    location: row.location,
    latitude: row.latitude,
    longitude: row.longitude,
    status,
    ...details,
  });
}

function errorDetails(error) {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

async function captureFailureScreenshot(page) {
  const screenshotPath = path.join(screenshotDir, `failure-${Date.now()}.png`);
  try {
    await mkdir(screenshotDir, { recursive: true });
    await page.screenshot({ path: screenshotPath, fullPage: true });
    return screenshotPath;
  } catch (error) {
    console.error(`could not save failure screenshot: ${errorDetails(error)}`);
    return null;
  }
}

function latestAttempts(attempts) {
  return new Map(attempts.map((attempt) => [attempt.key, attempt]));
}

function validateRows(rows) {
  rows.forEach((row, index) => {
    for (const column of ["name", "url", "note", "listName"]) {
      if (row[column] === undefined) {
        throw new Error(`row ${index + 1} is missing ${column}`);
      }
    }

    const hasLatitude =
      row.latitude !== undefined && String(row.latitude).trim() !== "";
    const hasLongitude =
      row.longitude !== undefined && String(row.longitude).trim() !== "";
    if (hasLatitude !== hasLongitude) {
      throw new Error(
        `row ${index + 1} must provide both latitude and longitude`
      );
    }
    if (hasLatitude && !sourceCoordinates(row)) {
      throw new Error(`row ${index + 1} has invalid source coordinates`);
    }
  });
}

async function findFirstVisible(page, candidates, description, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;

  while (Date.now() < deadline) {
    for (const candidate of candidates) {
      try {
        const locator = candidate().first();
        if ((await locator.count()) > 0 && (await locator.isVisible())) {
          return locator;
        }
      } catch (error) {
        lastError = error;
      }
    }
    await sleep(500);
  }

  throw new Error(
    `could not find visible ${description}: ${lastError?.message ?? "timed out"}`
  );
}

async function clickOptional(candidates) {
  for (const candidate of candidates) {
    try {
      await candidate().first().click({ timeout: 1500 });
      return true;
    } catch {}
  }
  return false;
}

async function findListItem(page, listName, timeoutMs = 15000) {
  const escapedText = JSON.stringify(listName);
  const selectors = [
    `[role="menuitemradio"]:has-text(${escapedText})`,
    `[role="menuitemcheckbox"]:has-text(${escapedText})`,
    `[role="checkbox"]:has-text(${escapedText})`,
  ];
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      if ((await locator.count()) > 0) return locator;
    }

    await sleep(250);
  }

  return null;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function addNoteIfPossible(page, listName, note) {
  if (!note) return;

  const listGroup = page
    .getByRole("group", {
      name: new RegExp(`^Saved in ${escapeRegExp(listName)}$`, "i"),
    })
    .first();
  const textarea = listGroup
    .locator('textarea[aria-label="Add note"], textarea[aria-label="Edit note"]')
    .first();

  if (!(await textarea.isVisible().catch(() => false))) {
    const detailsText = new RegExp(
      `Saved\\s+in\\s+${escapeRegExp(listName)}`,
      "i"
    );
    await clickOptional([
      () => page.getByRole("button", { name: "Show place lists details" }),
      () => page.locator("button").filter({ hasText: detailsText }),
      () => page.locator('[role="button"]').filter({ hasText: detailsText }),
    ]);
  }

  try {
    await textarea.waitFor({ state: "visible", timeout: 10000 });
  } catch (error) {
    throw new Error(`could not find note field for ${listName}: ${error.message}`);
  }

  await textarea.fill(note);
  await textarea.press("Tab");
  await page.waitForTimeout(1000);
}

async function findSearchResult(page, name) {
  const searchName = name.split(",", 1)[0].trim().toLocaleLowerCase();
  const resultLinks = page.locator('a[href*="/maps/place/"]');

  for (let index = 0; index < (await resultLinks.count()); index += 1) {
    const resultLink = resultLinks.nth(index);
    const label = (await resultLink.getAttribute("aria-label")) ?? "";
    const text = await resultLink.innerText().catch(() => "");
    const resultText = `${label} ${text}`.toLocaleLowerCase();
    if (resultText.includes(searchName)) return resultLink;
  }

  return null;
}

async function findPlaceAddress(page) {
  const addressCandidates = [
    () => page.locator('[data-item-id="address"]'),
    () => page.locator('[aria-label^="Address:"]'),
  ];

  let addressLocator;
  try {
    addressLocator = await findFirstVisible(
      page,
      addressCandidates,
      "place address",
      5000
    );
  } catch {
    return null;
  }

  const label = (await addressLocator.getAttribute("aria-label")) ?? "";
  const text = await addressLocator.innerText().catch(() => "");
  const address = label.replace(/^Address:\s*/i, "").trim() || text.trim();
  return address || null;
}

function addressTokens(address) {
  const aliases = [
    [/\b(st|st\.)\b/g, "street"],
    [/\b(rd|rd\.)\b/g, "road"],
    [/\b(ave|ave\.)\b/g, "avenue"],
    [/\b(blvd|blvd\.)\b/g, "boulevard"],
    [/\b(hwy|hwy\.)\b/g, "highway"],
    [/\b(ste|ste\.)\b/g, "suite"],
    [/\b(usa|united states|united states of america)\b/g, "us"],
  ];
  let normalized = address
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase();
  for (const [pattern, replacement] of aliases) {
    normalized = normalized.replace(pattern, replacement);
  }
  return new Set(normalized.split(/[^a-z0-9]+/).filter(Boolean));
}

function addressesMatch(sourceAddress, placeAddress) {
  const sourceTokens = addressTokens(sourceAddress);
  const placeTokens = addressTokens(placeAddress);
  const sharedTokens = [...sourceTokens].filter((token) =>
    placeTokens.has(token)
  );
  const sharedNumbers = sharedTokens.filter((token) => /\d/.test(token));
  const sharedWords = sharedTokens.filter(
    (token) => token.length >= 4 && !/^\d+$/.test(token)
  );

  if (sharedNumbers.length > 0 && sharedWords.length > 0) return true;
  return sharedTokens.length >= 3 && sourceTokens.size <= 5;
}

function appendAddressSearchTerm(url, address) {
  if (!address?.trim()) return null;

  let parsedUrl;
  try {
    parsedUrl = new URL(normalizeMapsUrl(url));
  } catch {
    return null;
  }

  const match = parsedUrl.pathname.match(/^\/maps\/search\/(.+)\/@([^/]+)$/);
  if (!match) return null;

  let searchTerm;
  try {
    searchTerm = decodeURIComponent(match[1].replace(/\+/g, " "));
  } catch {
    searchTerm = match[1];
  }
  parsedUrl.pathname = `/maps/search/${encodeURIComponent(
    `${searchTerm} ${address.trim()}`
  )}/@${match[2]}`;
  return parsedUrl.toString();
}

function sourceCoordinates(row) {
  if (
    row.latitude === undefined ||
    row.longitude === undefined ||
    String(row.latitude).trim() === "" ||
    String(row.longitude).trim() === ""
  ) {
    return null;
  }

  const latitude = Number(row.latitude);
  const longitude = Number(row.longitude);
  if (!validCoordinates(latitude, longitude)) return null;
  return { latitude, longitude };
}

function validCoordinates(latitude, longitude) {
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  );
}

function placeCoordinatesFromUrl(url) {
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    return null;
  }

  if (!parsedUrl.pathname.includes("/place/")) return null;

  const dataMatch = parsedUrl.href.match(
    /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/
  );
  if (dataMatch) {
    const latitude = Number(dataMatch[1]);
    const longitude = Number(dataMatch[2]);
    return validCoordinates(latitude, longitude)
      ? { latitude, longitude }
      : null;
  }

  const atMatch = parsedUrl.href.match(
    /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/
  );
  if (atMatch) {
    const latitude = Number(atMatch[1]);
    const longitude = Number(atMatch[2]);
    return validCoordinates(latitude, longitude)
      ? { latitude, longitude }
      : null;
  }

  return null;
}

function distanceInMeters(first, second) {
  const earthRadiusM = 6_371_000;
  const toRadians = (degrees) => (degrees * Math.PI) / 180;
  const latitudeDelta = toRadians(second.latitude - first.latitude);
  const longitudeDelta = toRadians(second.longitude - first.longitude);
  const firstLatitude = toRadians(first.latitude);
  const secondLatitude = toRadians(second.latitude);
  const haversine = Math.min(
    1,
    Math.sin(latitudeDelta / 2) ** 2 +
      Math.cos(firstLatitude) *
        Math.cos(secondLatitude) *
        Math.sin(longitudeDelta / 2) ** 2
  );
  return 2 * earthRadiusM * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

async function verifyPlaceLocation(page, row, maxDistanceM) {
  const expected = sourceCoordinates(row);
  if (!expected) return;

  const actual = placeCoordinatesFromUrl(page.url());
  if (actual) {
    const distanceM = distanceInMeters(expected, actual);
    if (distanceM > maxDistanceM) {
      throw new Error(
        `location mismatch for ${row.name}: Google Maps resolved ${actual.latitude},${actual.longitude}, ` +
          `which is ${Math.round(distanceM)}m from source ${expected.latitude},${expected.longitude} ` +
          `(limit ${maxDistanceM}m)`
      );
    }

    console.log(
      `verified ${row.name}: ${Math.round(distanceM)}m from source coordinates`
    );
    return;
  }

  const placeAddress = await findPlaceAddress(page);
  if (!placeAddress) {
    throw new Error(
      `could not verify ${row.name}: Google Maps did not expose a place address (current URL: ${page.url()})`
    );
  }
  if (!row.address || !addressesMatch(row.address, placeAddress)) {
    throw new Error(
      `address mismatch for ${row.name}: Google Maps shows ${JSON.stringify(placeAddress)}, ` +
        `source address is ${JSON.stringify(row.address)}`
    );
  }

  console.log(`verified ${row.name}: matched place address`);
}

function unresolvedPlaceError(name, cause) {
  const error = new Error(
    `could not resolve ${name} to a Google Maps place result: ${cause.message}`
  );
  error.code = "PLACE_UNRESOLVED";
  return error;
}

async function findSaveButtonForSearch(page, row, searchUrl, candidates) {
  await page.goto(searchUrl, {
    waitUntil: "domcontentloaded",
    timeout: 45000,
  });
  await page.waitForTimeout(3500);

  try {
    return await findFirstVisible(page, candidates, "Save button");
  } catch (error) {
    const result = await findSearchResult(page, row.name);
    if (!result) {
      if (sourceCoordinates(row)) throw unresolvedPlaceError(row.name, error);
      throw error;
    }

    await result.click({ timeout: 10000 });
    await page.waitForTimeout(3500);
    try {
      return await findFirstVisible(page, candidates, "Save button after selecting result");
    } catch (afterSelectingError) {
      if (sourceCoordinates(row)) {
        throw unresolvedPlaceError(row.name, afterSelectingError);
      }
      throw afterSelectingError;
    }
  }
}

async function savePlace(page, row, maxDistanceM) {
  const saveButtonCandidates = [
    () => page.locator('[data-value="Save"], [data-value="Saved"]'),
    () => page.locator('[aria-label="Save"], [aria-label="Saved"]'),
    () => page.locator('[data-value*="Save"]'),
    () => page.locator('[aria-label^="Save"]'),
  ];
  const searchUrls = [normalizeMapsUrl(row.url)];
  const addressSearchUrl = appendAddressSearchTerm(row.url, row.address);
  if (addressSearchUrl && addressSearchUrl !== searchUrls[0]) {
    searchUrls.push(addressSearchUrl);
  }

  let saveButton;
  let lastError;
  for (let index = 0; index < searchUrls.length; index += 1) {
    const searchUrl = searchUrls[index];
    if (index > 0) {
      console.log(`retrying ${row.name} with its source address`);
    }

    try {
      saveButton = await findSaveButtonForSearch(
        page,
        row,
        searchUrl,
        saveButtonCandidates
      );
      break;
    } catch (error) {
      lastError = error;
      if (error.code !== "PLACE_UNRESOLVED" || index === searchUrls.length - 1) {
        throw error;
      }
    }
  }

  if (!saveButton) throw lastError;

  await verifyPlaceLocation(page, row, maxDistanceM);
  await saveButton.click({ timeout: 10000 });

  const listItem = await findListItem(page, row.listName);
  if (!listItem) throw new Error(`could not find list ${row.listName}`);

  const checked = await listItem.getAttribute("aria-checked").catch(() => null);
  if (checked === "true") {
    console.log(`already saved: ${row.name} -> ${row.listName}`);
    await page.keyboard.press("Escape").catch(() => {});
    await addNoteIfPossible(page, row.listName, row.note);
    return;
  }

  await listItem.click({ timeout: 10000 });
  await page.waitForTimeout(1000);
  await page.keyboard.press("Escape").catch(() => {});
  await addNoteIfPossible(page, row.listName, row.note);
}

const options = getopts(process.argv.slice(2), {
  alias: {
    checkpoint: ["c"],
    limit: ["l"],
    delayMs: ["delay-ms", "delay"],
    dryRun: ["dry-run"],
    listName: ["list-name", "list"],
    continueOnError: ["continue-on-error", "continue"],
    maxDistanceM: ["max-distance-m", "max-distance"],
    retryFailed: ["retry-failed", "retry-errors", "retry"],
    skipAttempted: ["skip-attempted", "skip-tried"],
  },
  default: {
    checkpoint: checkpointDefault,
    delayMs: 2500,
    maxDistanceM: 1000,
  },
});

const csvFile = options._[0];
if (!csvFile) {
  console.error(usage());
  process.exit(1);
}

const rows = parse(await readFile(csvFile), {
  bom: true,
  columns: true,
  trim: true,
});
validateRows(rows);

const selectedRows = options.listName
  ? rows.filter((row) => row.listName === options.listName)
  : rows;
if (options.listName && selectedRows.length === 0) {
  const listNames = [...new Set(rows.map((row) => row.listName))].sort();
  throw new Error(
    `no rows found for listName ${JSON.stringify(options.listName)}; available listNames: ${listNames.join(", ")}`
  );
}

const checkpoint = await readCheckpoint(options.checkpoint);
const completed = new Set(checkpoint.completed);
const attemptedKeys = new Set(checkpoint.attempts.map((attempt) => attempt.key));
if (options.retryFailed && options.skipAttempted) {
  throw new Error("--retry-failed and --skip-attempted cannot be used together");
}
const limit = options.limit ? Number(options.limit) : Infinity;
const delayMs = Number(options.delayMs);
const maxDistanceM = Number(options.maxDistanceM);
if (!Number.isFinite(maxDistanceM) || maxDistanceM <= 0) {
  throw new Error("--max-distance-m must be a positive number");
}
const skipKeys = options.retryFailed
  ? completed
  : new Set([...completed, ...attemptedKeys]);
const pendingRows = selectedRows.filter((row) => !skipKeys.has(placeKey(row)));
const completedRows = selectedRows.filter((row) =>
  completed.has(placeKey(row))
).length;
const attemptedRows = selectedRows.filter((row) =>
  attemptedKeys.has(placeKey(row))
).length;
const latest = latestAttempts(checkpoint.attempts);
const previousFailures = selectedRows.filter((row) => {
  const key = placeKey(row);
  return !completed.has(key) && latest.get(key)?.status === "failed";
});

if (options.dryRun) {
  console.log(`listName: ${options.listName ?? "all"}`);
  console.log(`valid rows: ${selectedRows.length}`);
  console.log(`completed rows: ${completedRows}`);
  console.log(`attempted rows: ${attemptedRows}`);
  console.log(`pending rows: ${pendingRows.length}`);
  console.log(
    options.retryFailed
      ? `previous failures to retry: ${previousFailures.length}`
      : `previous failures skipped: ${previousFailures.length}`
  );
  process.exit(0);
}

const context = await launchMapsContext();
const page = context.pages()[0] ?? (await context.newPage());
let attempted = 0;
let succeeded = 0;
let failed = 0;

try {
  for (const row of pendingRows) {
    if (attempted >= limit) break;

    attempted += 1;
    const startedAt = new Date().toISOString();
    console.log(`[${attempted}] saving ${row.name} -> ${row.listName}`);

    try {
      await savePlace(page, row, maxDistanceM);

      const key = placeKey(row);
      completed.add(key);
      checkpoint.completed = Array.from(completed);
      recordAttempt(checkpoint, row, "succeeded", {
        startedAt,
        finishedAt: new Date().toISOString(),
        googleUrl: page.url(),
        maxDistanceM,
      });
      await writeCheckpoint(options.checkpoint, checkpoint);
      succeeded += 1;
    } catch (error) {
      const screenshotPath = await captureFailureScreenshot(page);
      recordAttempt(checkpoint, row, "failed", {
        startedAt,
        finishedAt: new Date().toISOString(),
        error: errorDetails(error),
        screenshot: screenshotPath,
        googleUrl: page.url(),
        maxDistanceM,
      });
      await writeCheckpoint(options.checkpoint, checkpoint);
      failed += 1;
      console.error(`failed ${row.name}: ${errorDetails(error)}`);
      if (!options.continueOnError) throw error;
    }

    await sleep(delayMs);
  }
} finally {
  await context.close();
}

console.log(`attempted ${attempted} place(s); succeeded ${succeeded}; failed ${failed}`);
