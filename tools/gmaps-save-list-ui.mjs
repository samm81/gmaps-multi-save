import { sleep } from "./gmaps-playwright.mjs";
import {
  absoluteMapsUrl,
  addressesMatch,
  distanceInMeters,
  hasSourceLocation,
  placeNamesMatch,
  placeReferenceFromUrl,
  placesMatch,
  sourceCoordinates,
} from "./gmaps-place.mjs";
import { errorCodes, runnerError, unresolvedPlaceError } from "./gmaps-errors.mjs";

const googleListNameMaxLength = 40;
const actionSettleMs = 500;
const navigationSettleMs = 2500;
const pollIntervalMs = 250;
const savedListItemSelector =
  '[role="menuitemradio"], [role="menuitemcheckbox"], [role="checkbox"]';

export function truncateListName(listName) {
  return listName.slice(0, googleListNameMaxLength);
}

export async function findFirstVisible(
  page,
  candidates,
  description,
  timeoutMs = 15000
) {
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

export function saveButtonCandidates(page) {
  return [
    () => page.locator('[data-value="Save"], [data-value="Saved"]'),
    () => page.locator('[aria-label^="Save"], [aria-label^="Saved"]'),
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

export async function capturePlaceIdentity(
  page,
  maxDistanceM,
  fallbackUrl = null
) {
  const currentUrl = page.url();
  const currentReference = placeReferenceFromUrl(currentUrl);
  const fallbackReference = placeReferenceFromUrl(fallbackUrl);
  if (
    currentReference &&
    fallbackReference &&
    !placesMatch(currentReference, fallbackReference, maxDistanceM)
  ) {
    throw runnerError(
      errorCodes.placeUnverified,
      `Google Maps changed place while handling the row: ` +
        `${fallbackUrl ?? "the expected place"} -> ${currentUrl ?? "the current page"}`
    );
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
        throw runnerError(
          errorCodes.locationUnverified,
          `address mismatch for ${row.name}: Google Maps shows ${JSON.stringify(identity.address)}, ` +
            `source address is ${JSON.stringify(row.address)}`
        );
      }
      console.log(`verified ${row.name}: matched place address`);
    } else if (requireSourceLocation) {
      throw runnerError(
        errorCodes.locationUnverified,
        `could not verify ${row.name}: Google Maps did not expose a place address to compare with the source`
      );
    }
    return identity;
  }

  const actual = identity.coordinates;
  if (actual) {
    const distanceM = distanceInMeters(expected, actual);
    if (distanceM > maxDistanceM) {
      throw runnerError(
        errorCodes.locationUnverified,
        `location mismatch for ${row.name}: Google Maps resolved ${actual.latitude},${actual.longitude}, ` +
          `which is ${Math.round(distanceM)}m from source ${expected.latitude},${expected.longitude} ` +
          `(limit ${maxDistanceM}m)`
      );
    }

    console.log(
      `verified ${row.name}: ${Math.round(distanceM)}m from source coordinates`
    );
    return { ...identity, distanceM };
  }

  const placeAddress = identity.address;
  if (!placeAddress) {
    throw runnerError(
      errorCodes.locationUnverified,
      `could not verify ${row.name}: Google Maps did not expose a place address (current URL: ${page.url()})`
    );
  }
  if (!row.address || !addressesMatch(row.address, placeAddress)) {
    throw runnerError(
      errorCodes.locationUnverified,
      `address mismatch for ${row.name}: Google Maps shows ${JSON.stringify(placeAddress)}, ` +
        `source address is ${JSON.stringify(row.address)}`
    );
  }

  console.log(`verified ${row.name}: matched place address`);
  return identity;
}

export async function verifyPlaceLocation(
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

export async function openMapsUrl(page, url) {
  try {
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });
  } catch (error) {
    throw runnerError(
      errorCodes.navigationUnavailable,
      `could not navigate to Google Maps: ${error.message}`
    );
  }
  await page.waitForTimeout(navigationSettleMs);
}

async function findSearchResult(page, name, timeoutMs = 15000) {
  const searchName = name.split(",", 1)[0].trim().toLocaleLowerCase();
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    // A search can become a place page without exposing a matching result link.
    if (placeReferenceFromUrl(page.url())) return null;

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

export async function selectPlaceCandidate(page, row, searchUrl) {
  await openMapsUrl(page, searchUrl);

  const initialUrl = page.url();
  const initialReference = placeReferenceFromUrl(initialUrl);
  let referenceUrl = initialReference ? initialUrl : null;

  if (!initialReference) {
    const result = await findSearchResult(page, row.name);
    if (result) {
      referenceUrl = await result.getAttribute("href");
      await result.click({ timeout: 10000 });
      await page.waitForTimeout(navigationSettleMs);
    } else {
      // Google can redirect to an alternate-name place while the result wait runs.
      const selectedUrl = page.url();
      if (placeReferenceFromUrl(selectedUrl)) {
        referenceUrl = selectedUrl;
      } else {
        const selectedName = await findPlaceName(page);
        // With source metadata, let location verification decide whether the name is an alias.
        if (!placeNamesMatch(row.name, selectedName) && !hasSourceLocation(row)) {
          throw unresolvedPlaceError(
            row.name,
            new Error(
              `Google Maps did not show a matching result (current place: ${JSON.stringify(selectedName)})`
            ),
            { resultUrl: selectedUrl }
          );
        }
      }
    }
  }

  return { referenceUrl };
}

export async function findSaveButton(page) {
  try {
    return await findFirstVisible(
      page,
      saveButtonCandidates(page),
      "Save button"
    );
  } catch (error) {
    throw runnerError(
      errorCodes.saveUnavailable,
      `could not find visible Save button: ${error.message}`
    );
  }
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

async function ensureListPickerOpen(page, listName) {
  const existingListItem = await findListItem(page, listName, 1000);
  if (existingListItem) return existingListItem;

  if (!(await listPickerIsOpen(page))) {
    await page.waitForTimeout(actionSettleMs);
    const saveButton = await findFirstVisible(
      page,
      saveButtonCandidates(page),
      "Save button"
    );
    await saveButton.click({ timeout: 10000 });
  }

  const listItem = await findListItem(page, listName);
  if (!listItem) {
    throw runnerError(
      errorCodes.listUnavailable,
      `could not find list ${truncateListName(listName)}`
    );
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

async function setListChecked(page, listName, desiredChecked) {
  const listItem = await ensureListPickerOpen(page, listName);
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
    const finalListItem = await ensureListPickerOpen(page, listName);
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

export async function setListMembership(page, listName, desiredChecked) {
  return setListChecked(page, listName, desiredChecked);
}

export async function correctMichelinListMembership(page, row) {
  const targetListName = truncateListName(row.listName);
  const movedFrom = [];
  const targetListItem = await ensureListPickerOpen(page, row.listName);
  const initiallyChecked =
    (await targetListItem.getAttribute("aria-checked").catch(() => null)) ===
    "true";

  if (!/^michelin-/i.test(row.listName)) {
    await setListChecked(page, row.listName, true);
    return { initiallyChecked, movedFrom };
  }

  const checkedMichelinListNames = await getCheckedMichelinListNames(
    page,
    targetListName
  );
  for (const listName of checkedMichelinListNames) {
    console.log(`moving ${row.name}: ${listName} -> ${targetListName}`);
    await setListChecked(page, listName, false);
    movedFrom.push(listName);
  }

  await setListChecked(page, row.listName, true);
  return { initiallyChecked, movedFrom };
}

export async function removeWrongMichelinMemberships(page, row) {
  if (!/^michelin-/i.test(row.listName)) {
    return { removedFrom: [] };
  }

  const targetListName = truncateListName(row.listName);
  await ensureListPickerOpen(page, row.listName);
  const checkedWrongListNames = await getCheckedMichelinListNames(
    page,
    targetListName
  );
  const removedFrom = [];
  for (const listName of checkedWrongListNames) {
    console.log(`removing wrong saved list: ${row.name} -> ${listName}`);
    await setListChecked(page, listName, false);
    removedFrom.push(listName);
  }

  await page.keyboard.press("Escape").catch(() => {});
  return { removedFrom };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function addNoteIfPossible(page, listName, note, noteTimeoutMs) {
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
    throw runnerError(
      errorCodes.noteUnavailable,
      `could not find note field for ${visibleListName}: ${error.message}`
    );
  }

  await textarea.fill(note);
  await textarea.press("Tab");
  await page.waitForTimeout(actionSettleMs);
}
