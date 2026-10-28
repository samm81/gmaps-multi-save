import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "csv-parse/sync";
import getopts from "getopts";
import {
  launchMapsContext,
  normalizeMapsUrl,
  sleep,
} from "./gmaps-playwright.mjs";
import { makeGmapsSearchUrl } from "./gmaps-url.mjs";
import { findMichelinMapLocation } from "./michelin-page.mjs";
import {
  hasSourceLocation,
  maxDistanceMDefault,
  placeReferenceFromUrl,
  placesMatch,
  searchAttemptsForRow,
  sourceCoordinates,
} from "./gmaps-place.mjs";
import {
  errorCodes,
  runnerError,
} from "./gmaps-errors.mjs";
import {
  manifestDirDefault,
  manifestRemoveEntry,
  manifestUpsertEntry,
} from "./gmaps-manifest.mjs";
import {
  addNoteIfPossible,
  findSaveButton,
  listSavedCheck,
  noteSavedCheck,
  selectPlaceCandidate,
  setListMembership,
  verifyPlaceLocation,
} from "./gmaps-save-list-ui.mjs";

const checkpointDefault = ".playwright/gmaps-save-checkpoint.json";
const screenshotDir = "output/playwright";
const browserReopenAttempts = 3;
const browserReopenDelayMs = 500;
const rowDelayMsDefault = 250;
const noteTimeoutMsDefault = 60000;
const placeRetryableErrorCodes = new Set([
  errorCodes.placeUnresolved,
  errorCodes.placeAmbiguous,
  errorCodes.placeUnverified,
  errorCodes.locationUnverified,
  errorCodes.saveUnavailable,
  errorCodes.navigationUnavailable,
]);
const michelinFallbackErrorCodes = new Set([
  errorCodes.placeUnresolved,
  errorCodes.placeAmbiguous,
  errorCodes.placeUnverified,
  errorCodes.locationUnverified,
]);

function usage() {
  return [
    "usage: npm run gmaps:save-list -- places.csv [--list-name name] [--limit 20]",
    "       [--checkpoint path] [--continue-on-error] [--delay-ms 250]",
    "       [--max-distance-m 1000] [--note-timeout-ms 60000]",
    "       [--manifest-dir local]",
    "       [--address-only] [--retry-failed] [--remove | --note-only] [--dry-run]",
    "",
    "CSV columns: name,url,note,listName; optional source metadata: michelinUrl,address,location,latitude,longitude",
    "Each row resolves and verifies one Google Maps place before changing saved lists.",
    "Google Maps list-name lookups use the first 40 characters.",
    "Each new checkpoint stores a hashed copy of its source CSV beside the checkpoint.",
    "Successful saves update one place manifest per list under --manifest-dir.",
    "Rerunning the same command skips rows already attempted; use --retry-failed to retry failures.",
    "Use --remove to unsave the exact place URL from its list instead of saving it.",
    "Use --note-only to update notes only for places already in their list.",
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

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function sourceSnapshotFor(checkpointFile, csvFile, csvContents, rowCount) {
  return {
    sourceFile: path.resolve(csvFile),
    snapshotFile: path.resolve(`${checkpointFile}.source.csv`),
    sha256: sha256(csvContents),
    rowCount,
    capturedAt: new Date().toISOString(),
  };
}

async function ensureSourceSnapshot(
  checkpointFile,
  checkpoint,
  csvFile,
  csvContents,
  rowCount
) {
  const current = sourceSnapshotFor(
    checkpointFile,
    csvFile,
    csvContents,
    rowCount
  );
  const previous = checkpoint.sourceSnapshot;
  if (previous?.sha256 && previous.sha256 !== current.sha256) {
    throw new Error(
      `source CSV changed since checkpoint ${checkpointFile}; use a new checkpoint`
    );
  }

  const snapshotFile = previous?.snapshotFile
    ? path.resolve(previous.snapshotFile)
    : current.snapshotFile;
  try {
    const snapshotContents = await readFile(snapshotFile);
    if (sha256(snapshotContents) !== current.sha256) {
      throw new Error(
        `source snapshot does not match ${csvFile}: ${snapshotFile}`
      );
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await mkdir(path.dirname(snapshotFile), { recursive: true });
    await writeFile(snapshotFile, csvContents);
  }

  if (previous?.sha256 === current.sha256 && previous.snapshotFile) {
    return false;
  }

  checkpoint.sourceSnapshot = {
    ...current,
    snapshotFile,
  };
  return true;
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
    michelinUrl: row.michelinUrl,
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

function assertSamePlace(row, first, second, maxDistanceM) {
  if (placesMatch(first, second, maxDistanceM)) return;

  throw runnerError(
    errorCodes.placeUnverified,
    `Google Maps changed place after saving ${row.name}: ` +
      `${JSON.stringify(first.name)} -> ${JSON.stringify(second.name)}`
  );
}

function assertExpectedPlace(row, expected, actual, maxDistanceM) {
  if (placesMatch(expected, actual, maxDistanceM)) return;

  throw runnerError(
    errorCodes.placeUnverified,
    `Google Maps resolved ${row.name} to a different place than the source URL`
  );
}

async function resolveAttempt(
  page,
  row,
  searchAttempt,
  maxDistanceM,
  verificationOptions
) {
  const searchRow = searchAttempt.searchRow ?? row;
  const candidate = await selectPlaceCandidate(
    page,
    searchRow,
    searchAttempt.url,
    maxDistanceM
  );
  const verifiedPlace = await verifyPlaceLocation(
    page,
    row,
    maxDistanceM,
    candidate.referenceUrl,
    verificationOptions
  );

  let saveButton;
  try {
    saveButton = await findSaveButton(page);
  } catch (error) {
    if (error.code !== errorCodes.saveUnavailable) throw error;

    console.error(`reopening ${row.name} after Google Maps lost the place page`);
    const recoveredCandidate = await selectPlaceCandidate(
      page,
      row,
      verifiedPlace.googleUrl,
      maxDistanceM
    );
    const recoveredPlace = await verifyPlaceLocation(
      page,
      row,
      maxDistanceM,
      recoveredCandidate.referenceUrl,
      verificationOptions
    );
    saveButton = await findSaveButton(page);
    return {
      ...recoveredCandidate,
      verifiedPlace: recoveredPlace,
      saveButton,
      resolution: searchAttempt.resolution ?? "google-search",
      verificationOptions,
    };
  }

  return {
    ...candidate,
    verifiedPlace,
    saveButton,
    resolution: searchAttempt.resolution ?? "google-search",
    verificationOptions,
  };
}

async function resolveMichelinFallback(
  page,
  row,
  maxDistanceM,
  previousAttempts
) {
  const mapLocation = await findMichelinMapLocation(page, row.michelinUrl);
  const coordinates = mapLocation.coordinates ?? sourceCoordinates(row);
  if (!coordinates) {
    throw runnerError(
      errorCodes.locationUnverified,
      `could not verify ${row.name}: Michelin map did not expose coordinates`
    );
  }
  const searchRow = {
    ...row,
    latitude: coordinates.latitude,
    longitude: coordinates.longitude,
  };
  const mapQuery = mapLocation.query && !mapLocation.coordinates
    ? mapLocation.query
    : row.address || row.name;
  const resolved = await resolveAttempt(
    page,
    row,
    {
      url: makeGmapsSearchUrl(
        `restaurant ${mapQuery}`,
        coordinates.latitude,
        coordinates.longitude
      ),
      description: "its Michelin map location",
      resolution: "michelin-map",
      searchRow,
    },
    Math.min(maxDistanceM, 100),
    {
      expectedCoordinates: coordinates,
      requireAddressMatchForNameMismatch: true,
    }
  );

  return {
    ...resolved,
    michelinMapCoordinates: mapLocation.coordinates,
    resolutionAttempts: previousAttempts,
  };
}

async function resolvePlace(
  page,
  row,
  maxDistanceM,
  { expectedReference = null, verificationOptions = {} } = {}
) {
  const attempts = searchAttemptsForRow(row);
  const sourcePlaceId = row.michelinUrl?.trim()
    ? placeReferenceFromUrl(row.url)?.placeId
    : null;
  const placeVerificationOptions = {
    ...verificationOptions,
    trustedPlaceId: sourcePlaceId ?? verificationOptions.trustedPlaceId,
    requireAddressMatchForNameMismatch:
      Boolean(row.michelinUrl?.trim() && !sourcePlaceId) ||
      verificationOptions.requireAddressMatchForNameMismatch,
  };
  const failures = [];
  let lastError;

  for (let index = 0; index < attempts.length; index += 1) {
    const searchAttempt = attempts[index];
    if (index > 0) {
      console.log(`retrying ${row.name} with ${searchAttempt.description}`);
    }

    try {
      const resolved = await resolveAttempt(
        page,
        row,
        searchAttempt,
        Math.min(maxDistanceM, searchAttempt.maxDistanceM ?? maxDistanceM),
        placeVerificationOptions
      );
      if (expectedReference || sourcePlaceId) {
        assertExpectedPlace(
          row,
          expectedReference ?? placeReferenceFromUrl(row.url),
          resolved.verifiedPlace,
          maxDistanceM
        );
      }
      return resolved;
    } catch (error) {
      lastError = error;
      failures.push({
        description: searchAttempt.description,
        code: error.code,
        message: error.message,
      });

      const isLastAttempt = index === attempts.length - 1;
      if (isLastAttempt || !placeRetryableErrorCodes.has(error.code)) break;
    }
  }

  if (!lastError) {
    lastError = runnerError(
      errorCodes.placeUnresolved,
      `could not resolve ${row.name}`
    );
  }

  if (
    !expectedReference &&
    !sourcePlaceId &&
    row.michelinUrl?.trim() &&
    michelinFallbackErrorCodes.has(lastError.code)
  ) {
    const description = "its Michelin map location";
    console.log(`retrying ${row.name} with ${description}`);
    try {
      return await resolveMichelinFallback(
        page,
        row,
        maxDistanceM,
        failures
      );
    } catch (error) {
      lastError = error;
      failures.push({
        description,
        code: error.code,
        message: error.message,
      });
    }
  }

  lastError.resolutionAttempts = failures;
  throw lastError;
}

async function savePlace(
  page,
  row,
  maxDistanceM,
  noteTimeoutMs,
  manifestDir
) {
  let resolved = await resolvePlace(page, row, maxDistanceM);
  let savedPlace;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await resolved.saveButton.click({ timeout: 10000 });
      savedPlace = await verifyPlaceLocation(
        page,
        row,
        maxDistanceM,
        resolved.verifiedPlace.googleUrl,
        resolved.verificationOptions
      );
      assertSamePlace(row, resolved.verifiedPlace, savedPlace, maxDistanceM);
      break;
    } catch (error) {
      const placePageLost =
        attempt < 2 &&
        error.code === errorCodes.placeUnverified &&
        /Google Maps changed place while handling the row/.test(error.message);
      if (!placePageLost) throw error;

      console.error(`reopening ${row.name} after Google Maps lost the place page`);
      resolved = await resolveAttempt(
        page,
        row,
        {
          url: resolved.verifiedPlace.googleUrl,
          description: "the verified place",
          resolution: resolved.resolution,
        },
        maxDistanceM,
        resolved.verificationOptions
      );

      const recoveredSaveState = await resolved.saveButton.getAttribute(
        "data-value"
      );
      if (/^Saved$/i.test(recoveredSaveState ?? "")) {
        savedPlace = resolved.verifiedPlace;
        break;
      }
    }
  }

  const membership = await setListMembership(page, row.listName, true);
  if (membership.initiallyChecked) {
    console.log(`already saved: ${row.name} -> ${row.listName}`);
  }

  await manifestUpsertEntry(manifestDir, row, savedPlace);
  await page.keyboard.press("Escape").catch(() => {});
  await addNoteIfPossible(page, row.listName, row.note, noteTimeoutMs);
  return {
    ...savedPlace,
    resolution: resolved.resolution,
    ...(resolved.michelinMapCoordinates
      ? { michelinMapCoordinates: resolved.michelinMapCoordinates }
      : {}),
    ...(resolved.resolutionAttempts
      ? { resolutionAttempts: resolved.resolutionAttempts }
      : {}),
  };
}

async function removePlace(page, row, maxDistanceM, manifestDir) {
  const exactPlaceReference = placeReferenceFromUrl(normalizeMapsUrl(row.url));
  const verificationOptions =
    exactPlaceReference && !hasSourceLocation(row)
      ? { allowNameMismatchWithoutLocation: true, allowAddressPin: true }
      : { allowAddressPin: true };
  const resolved = await resolvePlace(page, row, maxDistanceM, {
    expectedReference: exactPlaceReference,
    verificationOptions,
  });

  const membership = await setListMembership(page, row.listName, false);
  if (!membership.changed) {
    console.log(`already removed: ${row.name} -> ${row.listName}`);
  } else {
    console.log(`removed: ${row.name} -> ${row.listName}`);
  }
  await manifestRemoveEntry(manifestDir, row, resolved.verifiedPlace);
  await page.keyboard.press("Escape").catch(() => {});
  return {
    googleUrl: resolved.verifiedPlace.googleUrl,
    removed: membership.changed,
  };
}

async function noteRepair(page, row, maxDistanceM, noteTimeoutMs) {
  if (!row.note) throw new Error(`missing note for ${row.name}`);
  const expectedReference = row.placeId ? { placeId: row.placeId } : null;
  const resolved = await resolvePlace(page, row, maxDistanceM, {
    expectedReference,
    verificationOptions: row.placeId
      ? { trustedPlaceId: row.placeId }
      : {},
  });
  if (!(await listSavedCheck(page, row.listName))) {
    throw runnerError(
      errorCodes.listUnavailable,
      `${row.name} is not saved in ${row.listName}`
    );
  }
  await page.keyboard.press("Escape").catch(() => {});
  if (!(await noteSavedCheck(page, row.listName, row.note, noteTimeoutMs))) {
    await addNoteIfPossible(page, row.listName, row.note, noteTimeoutMs);
    if (!(await noteSavedCheck(page, row.listName, row.note, noteTimeoutMs, true))) {
      throw runnerError(
        errorCodes.noteUnavailable,
        `note for ${row.listName} did not persist after reload`
      );
    }
  }
  return resolved.verifiedPlace;
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
    manifestDir: ["manifest-dir", "manifests"],
    noteTimeoutMs: ["note-timeout-ms", "note-timeout"],
    addressOnly: ["address-only"],
    retryFailed: ["retry-failed", "retry-errors", "retry"],
    skipAttempted: ["skip-attempted", "skip-tried"],
    remove: ["remove", "unsave"],
    noteOnly: ["note-only"],
  },
  default: {
    checkpoint: checkpointDefault,
    delayMs: rowDelayMsDefault,
    maxDistanceM: maxDistanceMDefault,
    manifestDir: manifestDirDefault,
    noteTimeoutMs: noteTimeoutMsDefault,
  },
});

async function main() {
  if (options.remove && options.noteOnly) {
    throw new Error("--remove and --note-only cannot be used together");
  }
  const csvFile = options._[0];
  if (!csvFile) {
    console.error(usage());
    process.exitCode = 1;
    return;
  }

  const csvContents = await readFile(csvFile);
  const parsedRows = parse(csvContents, {
    bom: true,
    columns: true,
    trim: true,
  });
  const rows = options.addressOnly
    ? parsedRows.map((row) => ({ ...row, latitude: "", longitude: "" }))
    : parsedRows;
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
  const attemptedKeys = new Set(
    checkpoint.attempts.map((attempt) => attempt.key)
  );
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
    return;
  }

  const sourceSnapshotChanged = await ensureSourceSnapshot(
    options.checkpoint,
    checkpoint,
    csvFile,
    csvContents,
    rows.length
  );
  if (sourceSnapshotChanged) {
    await writeCheckpoint(options.checkpoint, checkpoint);
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
        `[${attempted}] ${options.remove ? "removing" : options.noteOnly ? "adding note for" : "saving"} ${row.name} -> ${row.listName}`
      );

      try {
        const result = options.remove
          ? await removePlace(
              browser.page,
              row,
              maxDistanceM,
              options.manifestDir
            )
          : options.noteOnly
          ? await noteRepair(
              browser.page,
              row,
              maxDistanceM,
              noteTimeoutMs
            )
          : await savePlace(
              browser.page,
              row,
              maxDistanceM,
              noteTimeoutMs,
              options.manifestDir
            );

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
          } catch (reopenError) {
            recoveryError = reopenError;
            console.error(
              `could not recover Google Maps browser: ${errorDetails(reopenError)}`
            );
          }
        }

        recordAttempt(checkpoint, row, "failed", {
          startedAt,
          finishedAt: new Date().toISOString(),
          error: errorDetails(error),
          screenshot: screenshot.path,
          googleUrl: failedGoogleUrl,
          ...(error.resolutionAttempts
            ? { resolutionAttempts: error.resolutionAttempts }
            : {}),
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
}

await main();
