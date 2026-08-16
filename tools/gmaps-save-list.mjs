import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "csv-parse/sync";
import getopts from "getopts";
import {
  launchMapsContext,
  normalizeMapsUrl,
  sleep,
} from "./gmaps-playwright.mjs";
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
  addNoteIfPossible,
  correctMichelinListMembership,
  findSaveButton,
  openMapsUrl,
  removeWrongMichelinMemberships,
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
  errorCodes.placeUnverified,
  errorCodes.locationUnverified,
  errorCodes.saveUnavailable,
  errorCodes.navigationUnavailable,
]);

function usage() {
  return [
    "usage: npm run gmaps:save-list -- places.csv [--list-name name] [--limit 20]",
    "       [--checkpoint path] [--continue-on-error] [--delay-ms 250]",
    "       [--max-distance-m 100] [--note-timeout-ms 60000]",
    "       [--retry-failed] [--remove] [--dry-run]",
    "",
    "CSV columns: name,url,note,listName; optional source metadata: address,location,latitude,longitude",
    "Each row resolves and verifies one Google Maps place before changing saved lists.",
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
  const candidate = await selectPlaceCandidate(
    page,
    row,
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

  try {
    const saveButton = await findSaveButton(page);
    return { ...candidate, verifiedPlace, saveButton };
  } catch (error) {
    // A verified candidate is safe to use for wrong-list cleanup even if Save is unavailable.
    error.verifiedPlace = verifiedPlace;
    throw error;
  }
}

async function resolvePlace(
  page,
  row,
  maxDistanceM,
  { expectedReference = null, verificationOptions = {} } = {}
) {
  const attempts = searchAttemptsForRow(row);
  const failures = [];
  let cleanupCandidate = null;
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
        maxDistanceM,
        verificationOptions
      );
      if (expectedReference) {
        try {
          assertExpectedPlace(
            row,
            expectedReference,
            resolved.verifiedPlace,
            maxDistanceM
          );
        } catch (error) {
          error.verifiedPlace = resolved.verifiedPlace;
          throw error;
        }
      }
      return resolved;
    } catch (error) {
      lastError = error;
      if (
        error.verifiedPlace?.placeId ||
        error.verifiedPlace?.path ||
        error.verifiedPlace?.coordinates
      ) {
        cleanupCandidate = error.verifiedPlace;
      }
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
  if (cleanupCandidate) lastError.cleanupCandidate = cleanupCandidate;
  lastError.resolutionAttempts = failures;
  throw lastError;
}

async function savePlace(page, row, maxDistanceM, noteTimeoutMs) {
  const resolved = await resolvePlace(page, row, maxDistanceM);

  await resolved.saveButton.click({ timeout: 10000 });
  const savedPlace = await verifyPlaceLocation(
    page,
    row,
    maxDistanceM,
    resolved.verifiedPlace.googleUrl
  );
  assertSamePlace(row, resolved.verifiedPlace, savedPlace, maxDistanceM);

  const membership = await correctMichelinListMembership(page, row);
  if (membership.initiallyChecked && membership.movedFrom.length === 0) {
    console.log(`already saved: ${row.name} -> ${row.listName}`);
  } else if (membership.movedFrom.length > 0) {
    console.log(`corrected saved list: ${row.name} -> ${row.listName}`);
  }

  await page.keyboard.press("Escape").catch(() => {});
  await addNoteIfPossible(page, row.listName, row.note, noteTimeoutMs);
  return { ...savedPlace, movedFrom: membership.movedFrom };
}

async function removePlace(page, row, maxDistanceM) {
  const exactPlaceReference = placeReferenceFromUrl(normalizeMapsUrl(row.url));
  const verificationOptions =
    exactPlaceReference && !hasSourceLocation(row)
      ? { allowNameMismatchWithoutLocation: true }
      : {};
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
  await page.keyboard.press("Escape").catch(() => {});
  return {
    googleUrl: resolved.verifiedPlace.googleUrl,
    removed: membership.changed,
  };
}

async function cleanupResolutionFailure(page, row, error, maxDistanceM) {
  if (!error.cleanupCandidate) return;

  try {
    const candidate = error.cleanupCandidate;
    console.log(`reopening verified place for cleanup: ${row.name}`);
    await openMapsUrl(page, candidate.googleUrl);
    await verifyPlaceLocation(
      page,
      row,
      maxDistanceM,
      candidate.googleUrl,
      { requireSourceLocation: true }
    );
    error.cleanup = await removeWrongMichelinMemberships(page, row);
    if (error.cleanup.removedFrom.length > 0) {
      console.log(
        `cleaned up wrong saved lists for ${row.name}: ${error.cleanup.removedFrom.join(", ")}`
      );
    }
  } catch (cleanupError) {
    error.cleanupError = errorDetails(cleanupError);
    console.error(
      `could not clean up wrong Michelin memberships for ${row.name}: ${error.cleanupError}`
    );
  }
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

async function main() {
  const csvFile = options._[0];
  if (!csvFile) {
    console.error(usage());
    process.exitCode = 1;
    return;
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
        if (!options.remove) {
          await cleanupResolutionFailure(browser.page, row, error, maxDistanceM);
        }
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
          ...(error.cleanup ? { cleanup: error.cleanup } : {}),
          ...(error.cleanupError ? { cleanupError: error.cleanupError } : {}),
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
