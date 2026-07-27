import { mkdir, readFile, writeFile } from "node:fs/promises";
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
    "usage: npm run gmaps:save-list -- places.csv [--limit 20] [--delay-ms 2500] [--dry-run]",
    "",
    "CSV columns: name,url,note,listName",
    "Run `npm run gmaps:login` first to create the local Google session.",
  ].join("\n");
}

async function readCheckpoint(checkpointFile) {
  try {
    return JSON.parse(await readFile(checkpointFile, "utf8"));
  } catch {
    return { completed: [] };
  }
}

async function writeCheckpoint(checkpointFile, checkpoint) {
  await mkdir(path.dirname(checkpointFile), { recursive: true });
  await writeFile(checkpointFile, `${JSON.stringify(checkpoint, null, 2)}\n`);
}

function placeKey({ name, url, listName }) {
  return `${listName}\t${name}\t${url}`;
}

function validateRows(rows) {
  rows.forEach((row, index) => {
    for (const column of ["name", "url", "note", "listName"]) {
      if (row[column] === undefined) {
        throw new Error(`row ${index + 1} is missing ${column}`);
      }
    }
  });
}

async function clickFirst(page, candidates, description, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;

  while (Date.now() < deadline) {
    for (const candidate of candidates) {
      try {
        await candidate().first().click({ timeout: 1200 });
        return true;
      } catch (error) {
        lastError = error;
      }
    }
    await sleep(500);
  }

  throw new Error(`could not click ${description}: ${lastError?.message}`);
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
  const searchName = name.split(",", 1)[0].trim();
  const exact = page.getByText(searchName, { exact: true }).first();
  if ((await exact.count()) > 0) return exact;

  const firstWord = searchName.split(/\s+/)[0];
  if (firstWord.length < 4) return null;

  const firstWordMatch = page.getByText(firstWord, { exact: true }).first();
  if ((await firstWordMatch.count()) > 0) return firstWordMatch;
  return null;
}

async function savePlace(page, row) {
  await page.goto(normalizeMapsUrl(row.url), {
    waitUntil: "domcontentloaded",
    timeout: 45000,
  });
  await page.waitForTimeout(3500);

  const saveButtonCandidates = [
    () => page.locator('[data-value="Save"], [data-value="Saved"]'),
    () => page.locator('[aria-label="Save"], [aria-label="Saved"]'),
    () => page.locator('[data-value*="Save"]'),
    () => page.locator('[aria-label^="Save"]'),
  ];

  try {
    await clickFirst(page, saveButtonCandidates, "Save button");
  } catch (error) {
    const result = await findSearchResult(page, row.name);
    if (!result) throw error;

    await result.click({ timeout: 10000 });
    await page.waitForTimeout(3500);
    await clickFirst(page, saveButtonCandidates, "Save button after selecting result");
  }

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
  },
  default: {
    checkpoint: checkpointDefault,
    delayMs: 2500,
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

const checkpoint = await readCheckpoint(options.checkpoint);
const completed = new Set(checkpoint.completed);
const limit = options.limit ? Number(options.limit) : Infinity;
const delayMs = Number(options.delayMs);
const pendingRows = rows.filter((row) => !completed.has(placeKey(row)));

if (options.dryRun) {
  console.log(`valid rows: ${rows.length}`);
  console.log(`pending rows: ${pendingRows.length}`);
  process.exit(0);
}

const context = await launchMapsContext();
const page = context.pages()[0] ?? (await context.newPage());
let processed = 0;

try {
  for (const row of pendingRows) {
    if (processed >= limit) break;

    console.log(`[${processed + 1}] saving ${row.name} -> ${row.listName}`);
    await savePlace(page, row);

    const key = placeKey(row);
    completed.add(key);
    checkpoint.completed = Array.from(completed);
    await writeCheckpoint(options.checkpoint, checkpoint);

    processed += 1;
    await sleep(delayMs);
  }
} catch (error) {
  await mkdir(screenshotDir, { recursive: true });
  const screenshotPath = path.join(screenshotDir, `failure-${Date.now()}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  console.error(`saved failure screenshot: ${screenshotPath}`);
  throw error;
} finally {
  await context.close();
}

console.log(`processed ${processed} place(s)`);
