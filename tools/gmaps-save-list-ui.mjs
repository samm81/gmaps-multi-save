import { sleep } from "./gmaps-playwright.mjs";
import {
  absoluteMapsUrl,
  addressesMatch,
  distanceInMeters,
  hasSourceLocation,
  maxDistanceMDefault,
  placeNamesMatch,
  placeReferenceFromUrl,
  placesMatch,
  sourceCoordinates,
} from "./gmaps-place.mjs";
import { errorCodes, runnerError, unresolvedPlaceError } from "./gmaps-errors.mjs";

const googleListNameMaxLength = 40;
const actionSettleMs = 250;
const pollIntervalMs = 250;
const resultPollIntervalMs = 100;
const resultSettleMs = 300;
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
  const placeTitle = page.locator('[data-item-id="title"]').first();
  if (await placeTitle.isVisible().catch(() => false)) {
    const name = (await placeTitle.innerText().catch(() => "")).trim();
    if (name) return name;
  }

  const heading = page.locator("h1").first();
  try {
    await heading.waitFor({ state: "visible", timeout: timeoutMs });
  } catch {
    return null;
  }

  const headingName = (await heading.innerText().catch(() => "")).trim();
  if (!/^results?$/i.test(headingName)) return headingName || null;

  // On the split search/preview layout, the h1 belongs to the results pane.
  // Wait for the title belonging to the place preview instead of returning
  // the generic results heading as the place name.
  try {
    await placeTitle.waitFor({ state: "visible", timeout: timeoutMs });
  } catch {
    return null;
  }
  const name = (await placeTitle.innerText().catch(() => "")).trim();
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
}

async function waitForPlaceDetails(page, timeoutMs = 10000) {
  const details = [
    () => page.locator('[data-item-id="title"]'),
    () => page.locator('[data-item-id="address"]'),
    ...saveButtonCandidates(page),
  ];

  try {
    await findFirstVisible(page, details, "place details", timeoutMs);
  } catch {}
}

async function findSearchResult(
  page,
  row,
  maxDistanceM = maxDistanceMDefault,
  timeoutMs = 15000
) {
  const deadline = Date.now() + timeoutMs;
  let candidatesFoundAt = null;
  let candidateKeys = null;
  const expectedCoordinates = sourceCoordinates(row);

  while (Date.now() < deadline) {
    // A search can become a place page without exposing a matching result link.
    if (placeReferenceFromUrl(page.url())) return null;

    const resultLinks = page.locator('a[href*="/maps/place/"]');
    const resultEntries = await resultLinks.evaluateAll((links) =>
      links
        .map((link, index) => {
          const rectangle = link.getBoundingClientRect();
          const style = window.getComputedStyle(link);
          if (
            style.display === "none" ||
            style.visibility === "hidden" ||
            rectangle.width === 0 ||
            rectangle.height === 0
          ) {
            return null;
          }

          const resultCard = link.closest("article");
          return {
            index,
            label: link.getAttribute("aria-label") ?? "",
            linkText: link.innerText ?? "",
            cardText: resultCard?.innerText ?? "",
            href: link.getAttribute("href"),
          };
        })
        .filter(Boolean)
    );
    const candidates = new Map();
    for (const entry of resultEntries) {
      const resultLink = resultLinks.nth(entry.index);
      const { label, linkText, cardText, href } = entry;
      const resultText = `${label} ${linkText} ${cardText}`;
      const resultName = label || linkText || cardText.split(/\r?\n/)[0];
      const reference = placeReferenceFromUrl(href);
      const distanceM =
        expectedCoordinates && reference?.coordinates
          ? distanceInMeters(expectedCoordinates, reference.coordinates)
          : null;
      const coordinateMatch =
        distanceM !== null && distanceM <= maxDistanceM;
      const addressMatch = Boolean(
        row.address?.trim() && addressesMatch(row.address, resultText)
      );
      const nameMatch = placeNamesMatch(row.name, resultName);
      if (!coordinateMatch && !addressMatch && !nameMatch) continue;

      const key = reference?.placeId || reference?.path || href;
      const score =
        (coordinateMatch ? 1000 : 0) +
        (addressMatch ? 100 : 0) +
        (nameMatch ? 10 : 0) -
        (distanceM === null ? 0 : Math.min(distanceM, 100_000) / 1000);
      const candidate = {
        resultLink,
        href,
        name: resultName,
        reference,
        distanceM,
        coordinateMatch,
        addressMatch,
        nameMatch,
        score,
      };
      const previous = candidates.get(key);
      if (!previous || score > previous.score) {
        candidates.set(key, candidate);
      }
    }

    const distinctCandidates = [...candidates.values()];
    if (distinctCandidates.length === 0) {
      candidatesFoundAt = null;
      candidateKeys = null;
      await sleep(pollIntervalMs);
      continue;
    }

    const nextCandidateKeys = distinctCandidates
      .map((candidate) => candidate.reference?.placeId || candidate.href)
      .sort()
      .join("\n");
    if (nextCandidateKeys !== candidateKeys) {
      candidateKeys = nextCandidateKeys;
      candidatesFoundAt = Date.now();
    }

    candidatesFoundAt ??= Date.now();
    if (Date.now() - candidatesFoundAt < resultSettleMs) {
      await sleep(resultPollIntervalMs);
      continue;
    }

    const locationCandidates = distinctCandidates.filter(
      (candidate) => candidate.coordinateMatch || candidate.addressMatch
    );
    const locationNameMatches = locationCandidates.filter(
      (candidate) => candidate.nameMatch
    );
    if (locationNameMatches.length === 1) {
      return locationNameMatches[0].resultLink;
    }
    if (locationCandidates.length === 1) {
      return locationCandidates[0].resultLink;
    }
    if (locationCandidates.length > 1) {
      throw ambiguousSearchResultsError(row, locationCandidates);
    }

    const nameMatches = distinctCandidates.filter(
      (candidate) => candidate.nameMatch
    );
    if (nameMatches.length === 1) {
      return nameMatches[0].resultLink;
    }
    if (nameMatches.length > 1) {
      throw ambiguousSearchResultsError(row, nameMatches);
    }

    return distinctCandidates[0].resultLink;
  }

  return null;
}

function formatResultCandidate(candidate) {
  const distance =
    candidate.distanceM === null
      ? "no coordinate distance"
      : `${Math.round(candidate.distanceM)}m`;
  const evidence = [
    distance,
    candidate.addressMatch ? "address" : null,
    candidate.nameMatch ? "name" : null,
  ].filter(Boolean);
  return `${JSON.stringify(candidate.name)} (${evidence.join(", ")})`;
}

function ambiguousSearchResultsError(row, candidates) {
  return runnerError(
    errorCodes.placeAmbiguous,
    `ambiguous Google Maps results for ${row.name}: ${candidates
      .map((candidate) => formatResultCandidate(candidate))
      .join("; ")}`,
    {
      candidates: candidates.map((candidate) => ({
        name: candidate.name,
        href: candidate.href,
        distanceM: candidate.distanceM,
        addressMatch: candidate.addressMatch,
        nameMatch: candidate.nameMatch,
      })),
    }
  );
}

export async function selectPlaceCandidate(
  page,
  row,
  searchUrl,
  maxDistanceM = maxDistanceMDefault
) {
  await openMapsUrl(page, searchUrl);

  const initialUrl = page.url();
  const initialReference = placeReferenceFromUrl(initialUrl);
  let referenceUrl = initialReference ? initialUrl : null;

  if (!initialReference) {
    const result = await findSearchResult(page, row, maxDistanceM);
    if (result) {
      referenceUrl = await result.getAttribute("href");
      await result.click({ timeout: 10000 });
      await waitForPlaceDetails(page);
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
    // Google Maps sometimes closes the list picker after saving a list and
    // expands the saved-list card instead. The visible card is the membership
    // confirmation, even though the checkbox is no longer in the DOM.
    if (
      desiredChecked &&
      (await savedListGroup(page, listName).isVisible().catch(() => false))
    ) {
      return { initiallyChecked, changed: true };
    }

    // Do not reopen the picker while waiting for a newly saved card. Reopening
    // can race with Google's transition from the picker to the place details.
    const finalListItem = await findListItem(page, listName, 250);
    if (!finalListItem) {
      if (desiredChecked) {
        await sleep(pollIntervalMs);
        continue;
      }

      // Removing a list normally keeps the picker open. If Google closed it,
      // reopen it before checking that the removal completed.
      const reopenedListItem = await ensureListPickerOpen(page, listName);
      finalChecked = await reopenedListItem
        .getAttribute("aria-checked")
        .catch(() => null);
      if (finalChecked === String(desiredChecked)) {
        return { initiallyChecked, changed: true };
      }
      await sleep(pollIntervalMs);
      continue;
    }

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

function savedListGroup(page, listName) {
  const visibleListName = truncateListName(listName);
  return page
    .getByRole("group", {
      name: new RegExp(`^Saved in ${escapeRegExp(visibleListName)}$`, "i"),
    })
    .first();
}

export async function addNoteIfPossible(page, listName, note, noteTimeoutMs) {
  if (!note) return;

  const visibleListName = truncateListName(listName);
  const listGroup = savedListGroup(page, listName);
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
