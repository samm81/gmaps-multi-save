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
const googleListNameMaxLength = 40;
const noteTimeoutMsDefault = 60000;
const browserReopenAttempts = 3;
const actionSettleMs = 500;
const browserReopenDelayMs = 500;
const navigationSettleMs = 2500;
const pollIntervalMs = 250;
const rowDelayMsDefault = 1000;
const maxDistanceMDefault = 100;
const savedListItemSelector =
  '[role="menuitemradio"], [role="menuitemcheckbox"], [role="checkbox"]';
const placeRetryableErrorCodes = new Set([
  "PLACE_UNRESOLVED",
  "PLACE_UNVERIFIED",
  "LOCATION_UNVERIFIED",
]);
const placeCleanupErrorCodes = new Set(["PLACE_UNRESOLVED", "PLACE_UNVERIFIED"]);

function truncateListName(listName) {
  return listName.slice(0, googleListNameMaxLength);
}

function usage() {
  return [
    "usage: npm run gmaps:save-list -- places.csv [--list-name name] [--limit 20]",
    "       [--checkpoint path] [--continue-on-error] [--delay-ms 1000]",
    "       [--max-distance-m 100] [--note-timeout-ms 60000]",
    "       [--retry-failed] [--remove] [--dry-run]",
    "",
    "CSV columns: name,url,note,listName; optional source metadata: address,location,latitude,longitude",
    "Matching place results are selected and verified before they are saved.",
    "The same place is verified again after Save opens the list picker.",
    "Successful attempts record the verified place identity.",
    "Google Maps list-name lookups use the first 40 characters.",
    "Rerunning the same command skips rows already attempted; use --retry-failed to retry failures.",
    "Use --remove to unsave the exact place URL from its list instead of saving it.",
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

function pageIsClosed(page) {
  return !page || page.isClosed();
}

function pageUrl(page) {
  try {
    return page?.url() ?? null;
  } catch {
    return null;
  }
}

function isBrowserTargetClosed(page, error) {
  return (
    pageIsClosed(page) ||
    /Target page, context or browser has been closed|Target closed|browser has been closed|context has been closed/i.test(
      errorDetails(error)
    )
  );
}

async function openMapsBrowser() {
  const context = await launchMapsContext();
  const page = context.pages()[0] ?? (await context.newPage());
  return { context, page };
}

async function reopenMapsBrowser(browser) {
  await browser.context.close().catch(() => {});

  let lastError;
  for (let attempt = 1; attempt <= browserReopenAttempts; attempt += 1) {
    let reopened;
    try {
      reopened = await openMapsBrowser();
      try {
        await reopened.page.goto("https://www.google.com/maps", {
          waitUntil: "domcontentloaded",
          timeout: 45000,
        });
      } catch (navigationError) {
        if (pageIsClosed(reopened.page)) throw navigationError;
        console.error(
          `reopened browser, but could not load Google Maps home: ${errorDetails(navigationError)}`
        );
      }
      console.error("reopened Google Maps browser after it closed");
      return reopened;
    } catch (error) {
      lastError = error;
      if (reopened) await reopened.context.close().catch(() => {});
      if (attempt < browserReopenAttempts) {
        await sleep(attempt * browserReopenDelayMs);
      }
    }
  }

  throw new Error(
    `could not reopen Google Maps browser after ${browserReopenAttempts} attempts: ${errorDetails(lastError)}`
  );
}

async function captureFailureScreenshot(page) {
  const screenshotPath = path.join(screenshotDir, `failure-${Date.now()}.png`);
  try {
    await mkdir(screenshotDir, { recursive: true });
    await page.screenshot({ path: screenshotPath, fullPage: true });
    return { path: screenshotPath, error: null };
  } catch (error) {
    console.error(`could not save failure screenshot: ${errorDetails(error)}`);
    return { path: null, error };
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
    await sleep(pollIntervalMs);
  }

  throw new Error(
    `could not find visible ${description}: ${lastError?.message ?? "timed out"}`
  );
}

function saveButtonCandidates(page) {
  return [
    () => page.locator('[data-value="Save"], [data-value="Saved"]'),
    () =>
      page.locator(
        '[aria-label^="Save"], [aria-label^="Saved"]'
      ),
    () => page.locator('[data-value*="Save"]'),
  ];
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
  const visibleListName = truncateListName(listName);
  const candidates = page.locator(savedListItemSelector);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    for (let index = 0; index < (await candidates.count()); index += 1) {
      const locator = candidates.nth(index);
      if (!(await locator.isVisible().catch(() => false))) continue;

      const text = await locator.innerText().catch(() => "");
      const lines = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      const normalizedText = text.replace(/\s+/g, " ").trim();
      if (
        lines.includes(visibleListName) ||
        normalizedText === visibleListName ||
        normalizedText.startsWith(`${visibleListName} `)
      ) {
        return locator;
      }
    }

    await sleep(pollIntervalMs);
  }

  return null;
}

async function listPickerIsOpen(page) {
  const listItems = page.locator(savedListItemSelector);
  for (let index = 0; index < (await listItems.count()); index += 1) {
    if (await listItems.nth(index).isVisible().catch(() => false)) return true;
  }
  return false;
}

async function ensureListPickerOpen(page, listName, saveButtonCandidates) {
  const existingListItem = await findListItem(page, listName, 1000);
  if (existingListItem) return existingListItem;

  if (!(await listPickerIsOpen(page))) {
    await page.waitForTimeout(actionSettleMs);
    const saveButton = await findFirstVisible(
      page,
      saveButtonCandidates,
      "Save button"
    );
    await saveButton.click({ timeout: 10000 });
  }

  const listItem = await findListItem(page, listName);
  if (!listItem) {
    throw new Error(`could not find list ${truncateListName(listName)}`);
  }
  return listItem;
}

async function findVisibleMichelinListNames(page) {
  const listItems = page.locator(savedListItemSelector);
  const names = new Set();

  for (let index = 0; index < (await listItems.count()); index += 1) {
    const listItem = listItems.nth(index);
    if (!(await listItem.isVisible().catch(() => false))) continue;

    const lines = (await listItem.innerText().catch(() => ""))
      .split(/\r?\n/)
      .map((line) => line.trim());
    const listName = lines
      .map((line) => line.match(/^(michelin-\S+)/i)?.[1])
      .find(Boolean);
    if (listName) names.add(listName);
  }

  return [...names];
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function addNoteIfPossible(page, listName, note, noteTimeoutMs) {
  if (!note) return;

  const visibleListName = truncateListName(listName);

  const listGroup = page
    .getByRole("group", {
      name: new RegExp(`^Saved in ${escapeRegExp(visibleListName)}$`, "i"),
    })
    .first();
  const textarea = listGroup
    .locator('textarea[aria-label="Add note"], textarea[aria-label="Edit note"]')
    .first();

  if (!(await textarea.isVisible().catch(() => false))) {
    const detailsText = new RegExp(
      `Saved\\s+in\\s+${escapeRegExp(visibleListName)}`,
      "i"
    );
    await clickOptional([
      () => page.getByRole("button", { name: "Show place lists details" }),
      () => page.locator("button").filter({ hasText: detailsText }),
      () => page.locator('[role="button"]').filter({ hasText: detailsText }),
    ]);
  }

  try {
    await textarea.waitFor({ state: "visible", timeout: noteTimeoutMs });
  } catch (error) {
    throw new Error(
      `could not find note field for ${visibleListName}: ${error.message}`
    );
  }

  await textarea.fill(note);
  await textarea.press("Tab");
  await page.waitForTimeout(actionSettleMs);
}

async function getCheckedMichelinListNames(page, targetListName) {
  const visibleListNames = await findVisibleMichelinListNames(page);
  const checkedListNames = [];
  for (const listName of visibleListNames) {
    if (listName.toLocaleLowerCase() === targetListName.toLocaleLowerCase()) {
      continue;
    }

    const listItem = await findListItem(page, listName, 3000);
    if (!listItem) continue;
    const checked = await listItem.getAttribute("aria-checked").catch(() => null);
    if (checked === "true") checkedListNames.push(listName);
  }
  return checkedListNames;
}

async function setListChecked(page, listName, desiredChecked, saveButtonCandidates) {
  const listItem = await ensureListPickerOpen(
    page,
    listName,
    saveButtonCandidates
  );
  const checked = await listItem.getAttribute("aria-checked").catch(() => null);
  if (checked !== "true" && checked !== "false") {
    throw new Error(`could not determine whether ${listName} is saved`);
  }

  const initiallyChecked = checked === "true";
  if (initiallyChecked === desiredChecked) {
    return { initiallyChecked, changed: false };
  }

  await listItem.click({ timeout: 10000 });
  const deadline = Date.now() + 15000;
  let finalChecked;
  while (Date.now() < deadline) {
    const finalListItem = await ensureListPickerOpen(
      page,
      listName,
      saveButtonCandidates
    );
    finalChecked = await finalListItem
      .getAttribute("aria-checked")
      .catch(() => null);
    if (finalChecked === String(desiredChecked)) {
      return { initiallyChecked, changed: true };
    }
    await sleep(pollIntervalMs);
  }

  throw new Error(
    `could not ${desiredChecked ? "save" : "remove"} ${listName} ` +
      `(last state: ${finalChecked ?? "unknown"})`
  );
}

async function correctMichelinListMembership(page, row, saveButtonCandidates) {
  const targetListName = truncateListName(row.listName);
  const movedFrom = [];
  const targetListItem = await ensureListPickerOpen(
    page,
    row.listName,
    saveButtonCandidates
  );
  const initiallyChecked =
    (await targetListItem.getAttribute("aria-checked").catch(() => null)) ===
    "true";

  if (!/^michelin-/i.test(row.listName)) {
    await setListChecked(page, row.listName, true, saveButtonCandidates);
    return { initiallyChecked, movedFrom };
  }

  const checkedMichelinListNames = await getCheckedMichelinListNames(
    page,
    targetListName
  );
  for (const listName of checkedMichelinListNames) {
    console.log(`moving ${row.name}: ${listName} -> ${targetListName}`);
    await setListChecked(page, listName, false, saveButtonCandidates);
    movedFrom.push(listName);
  }

  await setListChecked(page, row.listName, true, saveButtonCandidates);
  return { initiallyChecked, movedFrom };
}

async function removeWrongMichelinMemberships(page, row, saveButtonCandidates) {
  if (!/^michelin-/i.test(row.listName)) {
    return { locationVerified: true, removedFrom: [] };
  }

  const targetListName = truncateListName(row.listName);
  await ensureListPickerOpen(page, row.listName, saveButtonCandidates);
  const checkedWrongListNames = await getCheckedMichelinListNames(
    page,
    targetListName
  );
  const removedFrom = [];
  for (const listName of checkedWrongListNames) {
    console.log(`removing wrong saved list: ${row.name} -> ${listName}`);
    await setListChecked(page, listName, false, saveButtonCandidates);
    removedFrom.push(listName);
  }

  await page.keyboard.press("Escape").catch(() => {});
  return { locationVerified: true, removedFrom };
}

async function findSearchResult(page, name, timeoutMs = 15000) {
  const searchName = name.split(",", 1)[0].trim().toLocaleLowerCase();
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const resultLinks = page.locator('a[href*="/maps/place/"]');
    for (let index = 0; index < (await resultLinks.count()); index += 1) {
      const resultLink = resultLinks.nth(index);
      if (!(await resultLink.isVisible().catch(() => false))) continue;
      const label = (await resultLink.getAttribute("aria-label")) ?? "";
      const text = await resultLink.innerText().catch(() => "");
      const resultText = `${label} ${text}`.toLocaleLowerCase();
      if (resultText.includes(searchName)) return resultLink;
    }
    await sleep(pollIntervalMs);
  }

  return null;
}

async function findPlaceName(page, timeoutMs = 10000) {
  const nameCandidates = [
    () => page.locator("h1"),
    () => page.locator('[data-item-id="title"]'),
  ];

  let nameLocator;
  try {
    nameLocator = await findFirstVisible(
      page,
      nameCandidates,
      "place name",
      timeoutMs
    );
  } catch {
    return null;
  }

  const name = (await nameLocator.innerText().catch(() => "")).trim();
  return name || null;
}

async function findPlaceAddress(page, timeoutMs = 5000) {
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
      timeoutMs
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
    parsedUrl = new URL(url, "https://www.google.com");
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

function placeIdFromUrl(url) {
  let parsedUrl;
  try {
    parsedUrl = new URL(url, "https://www.google.com");
  } catch {
    return null;
  }

  if (!parsedUrl.pathname.includes("/place/")) return null;
  const placeIdMatches = [
    ...parsedUrl.href.matchAll(/!3m\d+!1s([^!]+)/g),
  ];
  if (placeIdMatches.length > 0) {
    return placeIdMatches.at(-1)[1];
  }

  const fallbackMatches = [...parsedUrl.href.matchAll(/!1s([^!]+)/g)];
  return fallbackMatches.at(-1)?.[1] ?? null;
}

function placePathFromUrl(url) {
  let parsedUrl;
  try {
    parsedUrl = new URL(url, "https://www.google.com");
  } catch {
    return null;
  }

  if (!parsedUrl.pathname.includes("/place/")) return null;
  return parsedUrl.pathname.toLocaleLowerCase();
}

function placeReferenceFromUrl(url) {
  if (!url) return null;

  const placeId = placeIdFromUrl(url);
  const coordinates = placeCoordinatesFromUrl(url);
  const path = placePathFromUrl(url);
  if (!placeId && !coordinates && !path) return null;

  return { placeId, coordinates, path };
}

function placesMatch(first, second, maxDistanceM = maxDistanceMDefault) {
  if (!first || !second) return false;
  if (first.placeId && second.placeId) return first.placeId === second.placeId;
  if (first.coordinates && second.coordinates) {
    return distanceInMeters(first.coordinates, second.coordinates) <= maxDistanceM;
  }
  if (first.path && second.path) return first.path === second.path;
  if (first.name && second.name) {
    return placeNamesMatch(first.name, second.name);
  }
  return false;
}

function normalizedPlaceName(name) {
  return String(name ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function placeNamesMatch(expectedName, actualName) {
  const expected = normalizedPlaceName(expectedName?.split(",", 1)[0]);
  const actual = normalizedPlaceName(actualName);
  if (!expected || !actual) return false;
  return (
    expected === actual ||
    expected.includes(actual) ||
    actual.includes(expected)
  );
}

function absoluteMapsUrl(url) {
  if (!url) return null;
  try {
    return new URL(url, "https://www.google.com").toString();
  } catch {
    return url;
  }
}

async function capturePlaceIdentity(page, maxDistanceM, fallbackUrl = null) {
  const currentUrl = pageUrl(page);
  const currentReference = placeReferenceFromUrl(currentUrl);
  const fallbackReference = placeReferenceFromUrl(fallbackUrl);
  if (
    currentReference &&
    fallbackReference &&
    !placesMatch(currentReference, fallbackReference, maxDistanceM)
  ) {
    const error = new Error(
      `Google Maps changed place while handling the row: ` +
        `${fallbackUrl ?? "the expected place"} -> ${currentUrl ?? "the current page"}`
    );
    error.code = "PLACE_UNVERIFIED";
    throw error;
  }

  const reference = currentReference ?? fallbackReference;
  return {
    googleUrl: currentReference
      ? currentUrl
      : absoluteMapsUrl(fallbackUrl) ?? currentUrl,
    name: await findPlaceName(page),
    address: await findPlaceAddress(page, 3000),
    placeId: reference?.placeId ?? null,
    path: reference?.path ?? null,
    coordinates: reference?.coordinates ?? null,
  };
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

async function verifyPlaceLocationData(
  page,
  row,
  identity,
  maxDistanceM,
  { requireSourceLocation = false } = {}
) {
  const expected = sourceCoordinates(row);
  if (!expected) {
    if (row.address?.trim() && identity.address) {
      if (!addressesMatch(row.address, identity.address)) {
        const error = new Error(
          `address mismatch for ${row.name}: Google Maps shows ${JSON.stringify(identity.address)}, ` +
            `source address is ${JSON.stringify(row.address)}`
        );
        error.code = "LOCATION_UNVERIFIED";
        throw error;
      }
      console.log(`verified ${row.name}: matched place address`);
    } else if (requireSourceLocation) {
      const error = new Error(
        `could not verify ${row.name}: Google Maps did not expose a place address to compare with the source`
      );
      error.code = "LOCATION_UNVERIFIED";
      throw error;
    }
    return identity;
  }

  const actual = identity.coordinates;
  if (actual) {
    const distanceM = distanceInMeters(expected, actual);
    if (distanceM > maxDistanceM) {
      const error = new Error(
        `location mismatch for ${row.name}: Google Maps resolved ${actual.latitude},${actual.longitude}, ` +
          `which is ${Math.round(distanceM)}m from source ${expected.latitude},${expected.longitude} ` +
          `(limit ${maxDistanceM}m)`
      );
      error.code = "LOCATION_UNVERIFIED";
      throw error;
    }

    console.log(
      `verified ${row.name}: ${Math.round(distanceM)}m from source coordinates`
    );
    return { ...identity, distanceM };
  }

  const placeAddress = identity.address;
  if (!placeAddress) {
    const error = new Error(
      `could not verify ${row.name}: Google Maps did not expose a place address (current URL: ${pageUrl(page)})`
    );
    error.code = "LOCATION_UNVERIFIED";
    throw error;
  }
  if (!row.address || !addressesMatch(row.address, placeAddress)) {
    const error = new Error(
      `address mismatch for ${row.name}: Google Maps shows ${JSON.stringify(placeAddress)}, ` +
        `source address is ${JSON.stringify(row.address)}`
    );
    error.code = "LOCATION_UNVERIFIED";
    throw error;
  }

  console.log(`verified ${row.name}: matched place address`);
  return identity;
}

async function verifyPlaceLocation(
  page,
  row,
  maxDistanceM,
  fallbackUrl = null,
  {
    requireSourceLocation = false,
    allowNameMismatchWithoutLocation = false,
  } = {}
) {
  const identity = await capturePlaceIdentity(page, maxDistanceM, fallbackUrl);
  const nameMatches = placeNamesMatch(row.name, identity.name);

  const verified = await verifyPlaceLocationData(
    page,
    row,
    identity,
    maxDistanceM,
    {
      requireSourceLocation:
        requireSourceLocation ||
        (!nameMatches && !allowNameMismatchWithoutLocation),
    }
  );
  if (!nameMatches) {
    console.log(
      `verified ${row.name}: location matched despite Google Maps name ${JSON.stringify(identity.name)}`
    );
  }
  return verified;
}

function assertSamePlace(row, first, second, maxDistanceM) {
  if (placesMatch(first, second, maxDistanceM)) return;

  const error = new Error(
    `Google Maps changed place after saving ${row.name}: ` +
      `${JSON.stringify(first.name)} -> ${JSON.stringify(second.name)}`
  );
  error.code = "PLACE_UNVERIFIED";
  throw error;
}

function assertExpectedPlace(row, expected, actual, maxDistanceM) {
  if (placesMatch(expected, actual, maxDistanceM)) return;

  const error = new Error(
    `Google Maps resolved ${row.name} to a different place than the source URL`
  );
  error.code = "PLACE_UNVERIFIED";
  throw error;
}

function unresolvedPlaceError(name, cause) {
  const error = new Error(
    `could not resolve ${name} to a Google Maps place result: ${cause.message}`
  );
  error.code = "PLACE_UNRESOLVED";
  return error;
}

async function findPlaceForSearch(page, row, searchUrl, candidates) {
  await page.goto(searchUrl, {
    waitUntil: "domcontentloaded",
    timeout: 45000,
  });
  await page.waitForTimeout(navigationSettleMs);

  const currentUrl = pageUrl(page);
  const currentReference = placeReferenceFromUrl(currentUrl);
  let resultUrl = currentReference ? currentUrl : null;
  if (!currentReference) {
    const result = await findSearchResult(page, row.name);
    if (result) {
      resultUrl = await result.getAttribute("href");
      await result.click({ timeout: 10000 });
      await page.waitForTimeout(navigationSettleMs);
    } else {
      const selectedName = await findPlaceName(page);
      if (!placeNamesMatch(row.name, selectedName)) {
        const error = unresolvedPlaceError(
          row.name,
          new Error(
            `Google Maps did not show a matching result (current place: ${JSON.stringify(selectedName)})`
          )
        );
        error.resultUrl = pageUrl(page);
        throw error;
      }
    }
  }

  try {
    return {
      saveButton: await findFirstVisible(page, candidates, "Save button"),
      resultUrl,
    };
  } catch (error) {
    if (sourceCoordinates(row) || row.address?.trim()) {
      throw unresolvedPlaceError(row.name, error);
    }
    throw error;
  }
}

function searchAttemptsForRow(row) {
  const nameSearchUrl = normalizeMapsUrl(row.url);
  const addressSearchUrl = appendAddressSearchTerm(row.url, row.address);
  const attempts = [];
  if (addressSearchUrl && addressSearchUrl !== nameSearchUrl) {
    attempts.push({
      url: addressSearchUrl,
      description: "its name and source address",
    });
  }
  attempts.push({ url: nameSearchUrl, description: "its name only" });
  return attempts;
}

async function resolvePlace(
  page,
  row,
  maxDistanceM,
  candidates,
  {
    cleanupOnFailure = false,
    verificationOptions = {},
    expectedReference = null,
  } = {}
) {
  const searchAttempts = searchAttemptsForRow(row);
  let lastError;

  for (let index = 0; index < searchAttempts.length; index += 1) {
    const { url: searchUrl, description } = searchAttempts[index];
    let attemptResultUrl;
    if (index > 0) {
      console.log(`retrying ${row.name} with ${description}`);
    }

    try {
      const selected = await findPlaceForSearch(
        page,
        row,
        searchUrl,
        candidates
      );
      attemptResultUrl = selected.resultUrl;
      const verifiedPlace = await verifyPlaceLocation(
        page,
        row,
        maxDistanceM,
        attemptResultUrl,
        verificationOptions
      );
      if (expectedReference) {
        assertExpectedPlace(row, expectedReference, verifiedPlace, maxDistanceM);
      }
      return { ...selected, verifiedPlace };
    } catch (error) {
      lastError = error;
      const cleanupResultUrl = error.resultUrl ?? attemptResultUrl;
      const finalAttempt =
        !placeRetryableErrorCodes.has(error.code) ||
        index === searchAttempts.length - 1;
      if (!finalAttempt) continue;

      if (cleanupOnFailure && placeCleanupErrorCodes.has(error.code)) {
        try {
          await verifyPlaceLocation(
            page,
            row,
            maxDistanceM,
            cleanupResultUrl,
            { requireSourceLocation: true }
          );
          error.cleanup = await removeWrongMichelinMemberships(
            page,
            row,
            candidates
          );
        } catch (cleanupError) {
          error.cleanupError = errorDetails(cleanupError);
          console.error(
            `could not clean up wrong Michelin memberships for ${row.name}: ${errorDetails(cleanupError)}`
          );
        }
      }
      throw error;
    }
  }

  throw lastError;
}

async function savePlace(page, row, maxDistanceM, noteTimeoutMs) {
  const candidates = saveButtonCandidates(page);
  const resolved = await resolvePlace(
    page,
    row,
    maxDistanceM,
    candidates,
    { cleanupOnFailure: true }
  );

  await resolved.saveButton.click({ timeout: 10000 });
  const verifiedSavedPlace = await verifyPlaceLocation(
    page,
    row,
    maxDistanceM,
    resolved.verifiedPlace.googleUrl
  );
  assertSamePlace(
    row,
    resolved.verifiedPlace,
    verifiedSavedPlace,
    maxDistanceM
  );

  const membership = await correctMichelinListMembership(
    page,
    row,
    candidates
  );
  if (membership.initiallyChecked && membership.movedFrom.length === 0) {
    console.log(`already saved: ${row.name} -> ${row.listName}`);
  } else if (membership.movedFrom.length > 0) {
    console.log(`corrected saved list: ${row.name} -> ${row.listName}`);
  }
  await page.keyboard.press("Escape").catch(() => {});
  await addNoteIfPossible(page, row.listName, row.note, noteTimeoutMs);
  return { ...verifiedSavedPlace, movedFrom: membership.movedFrom };
}

async function removePlace(page, row, maxDistanceM) {
  const candidates = saveButtonCandidates(page);
  const exactPlaceReference = placeReferenceFromUrl(normalizeMapsUrl(row.url));
  const verificationOptions =
    exactPlaceReference && !sourceCoordinates(row) && !row.address?.trim()
      ? { allowNameMismatchWithoutLocation: true }
      : {};
  const resolved = await resolvePlace(
    page,
    row,
    maxDistanceM,
    candidates,
    {
      verificationOptions,
      expectedReference: exactPlaceReference,
    }
  );
  const membership = await setListChecked(
    page,
    row.listName,
    false,
    candidates
  );
  await page.keyboard.press("Escape").catch(() => {});
  if (!membership.changed) {
    console.log(`already removed: ${row.name} -> ${row.listName}`);
  } else {
    console.log(`removed: ${row.name} -> ${row.listName}`);
  }
  return {
    googleUrl: resolved.verifiedPlace.googleUrl,
    removed: membership.changed,
  };
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
    noteTimeoutMs: ["note-timeout-ms", "note-timeout"],
    retryFailed: ["retry-failed", "retry-errors", "retry"],
    skipAttempted: ["skip-attempted", "skip-tried"],
    remove: ["remove", "unsave"],
  },
  default: {
    checkpoint: checkpointDefault,
    delayMs: rowDelayMsDefault,
    maxDistanceM: maxDistanceMDefault,
    noteTimeoutMs: noteTimeoutMsDefault,
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
const noteTimeoutMs = Number(options.noteTimeoutMs);
if (!Number.isFinite(noteTimeoutMs) || noteTimeoutMs <= 0) {
  throw new Error("--note-timeout-ms must be a positive number");
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

let browser = await openMapsBrowser();
let attempted = 0;
let succeeded = 0;
let failed = 0;

try {
  for (const row of pendingRows) {
    if (attempted >= limit) break;

    attempted += 1;
    const startedAt = new Date().toISOString();
    console.log(
      `[${attempted}] ${options.remove ? "removing" : "saving"} ${row.name} -> ${row.listName}`
    );

    try {
      const result = options.remove
        ? await removePlace(browser.page, row, maxDistanceM)
        : await savePlace(browser.page, row, maxDistanceM, noteTimeoutMs);

      const key = placeKey(row);
      completed.add(key);
      checkpoint.completed = Array.from(completed);
      recordAttempt(checkpoint, row, "succeeded", {
        startedAt,
        finishedAt: new Date().toISOString(),
        googleUrl: result.googleUrl,
        ...(options.remove
          ? { removed: result.removed }
          : { verifiedPlace: result }),
        maxDistanceM,
        noteTimeoutMs,
      });
      await writeCheckpoint(options.checkpoint, checkpoint);
      succeeded += 1;
    } catch (error) {
      const failedGoogleUrl = pageUrl(browser.page);
      const screenshot = await captureFailureScreenshot(browser.page);
      let recoveryError = null;
      if (
        screenshot.error &&
        isBrowserTargetClosed(browser.page, screenshot.error)
      ) {
        try {
          browser = await reopenMapsBrowser(browser);
        } catch (error) {
          recoveryError = error;
          console.error(
            `could not recover Google Maps browser: ${errorDetails(error)}`
          );
        }
      }
      recordAttempt(checkpoint, row, "failed", {
        startedAt,
        finishedAt: new Date().toISOString(),
        error: errorDetails(error),
        screenshot: screenshot.path,
        googleUrl: failedGoogleUrl,
        ...(error.cleanup ? { cleanup: error.cleanup } : {}),
        ...(error.cleanupError ? { cleanupError: error.cleanupError } : {}),
        maxDistanceM,
        noteTimeoutMs,
      });
      await writeCheckpoint(options.checkpoint, checkpoint);
      failed += 1;
      console.error(`failed ${row.name}: ${errorDetails(error)}`);
      if (recoveryError) throw recoveryError;
      if (!options.continueOnError) throw error;
    }

    await sleep(delayMs);
  }
} finally {
  await browser.context.close().catch(() => {});
}

console.log(`attempted ${attempted} place(s); succeeded ${succeeded}; failed ${failed}`);
