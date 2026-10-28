import { readFile } from "node:fs/promises";
import getopts from "getopts";
import {
  manifestDirDefault,
  manifestEntryFromAttempt,
  manifestWriteEntries,
} from "./gmaps-manifest.mjs";

const options = getopts(process.argv.slice(2), {
  alias: {
    checkpoint: ["checkpoint", "c"],
    manifestDir: ["manifest-dir", "manifests"],
    includePartialSaves: ["include-partial-saves"],
    excludeListName: ["exclude-list-name", "exclude-list"],
    dryRun: ["dry-run"],
    help: ["h"],
  },
  default: {
    manifestDir: manifestDirDefault,
  },
});

function optionValues(value) {
  if (value === undefined || value === null) return [];
  return (Array.isArray(value) ? value : [value]).filter(Boolean);
}

function usage() {
  return [
    "usage: npm run gmaps:migrate-manifests -- --checkpoint file [--checkpoint file ...]",
    "       [--manifest-dir local] [--include-partial-saves]",
    "       [--exclude-list-name name] [--dry-run]",
    "",
    "Successful save attempts become per-list manifests. Successful removals",
    "remove the corresponding place from its list manifest. With",
    "--include-partial-saves, verified note-field failures are included when",
    "Google Maps had already returned a place URL after list membership.",
  ].join("\n");
}

if (options.help) {
  console.log(usage());
  process.exit(0);
}

const checkpointFiles = optionValues(options.checkpoint);
if (!checkpointFiles.length) {
  console.error(usage());
  process.exitCode = 1;
} else {
  const events = [];
  const excludedListNames = new Set(optionValues(options.excludeListName));
  let partialSaveCount = 0;
  let sequence = 0;

  for (const checkpointFile of checkpointFiles) {
    const checkpoint = JSON.parse(await readFile(checkpointFile, "utf8"));
    for (const attempt of checkpoint.attempts ?? []) {
      const isPartialSave =
        options.includePartialSaves &&
        attempt.status === "failed" &&
        /could not find note field/i.test(String(attempt.error ?? ""));
      if (attempt.status !== "succeeded" && !isPartialSave) continue;
      if (excludedListNames.has(attempt.listName)) continue;

      const entry = manifestEntryFromAttempt(attempt);
      if (!entry) continue;
      if (isPartialSave) partialSaveCount += 1;

      events.push({
        ...entry,
        action: Object.hasOwn(attempt, "removed") ? "remove" : "save",
        timestamp: attempt.finishedAt || attempt.startedAt || "",
        sequence,
      });
      sequence += 1;
    }
  }

  events.sort((first, second) => {
    const firstTime = Date.parse(first.timestamp);
    const secondTime = Date.parse(second.timestamp);
    if (Number.isFinite(firstTime) && Number.isFinite(secondTime)) {
      return firstTime - secondTime;
    }
    return first.sequence - second.sequence;
  });

  const entriesByList = new Map();
  const keyPlaceIds = new Map();
  let conflicts = 0;
  for (const event of events) {
    const entries = entriesByList.get(event.listName) ?? [];
    const key = `${event.listName}\t${event.key}`;
    if (event.action === "save") {
      const previousPlaceId = keyPlaceIds.get(key);
      if (previousPlaceId && previousPlaceId !== event.placeId) conflicts += 1;
      keyPlaceIds.set(key, event.placeId);
      entries.push(event);
      entriesByList.set(
        event.listName,
        entries.filter(
          (entry, index) =>
            index === entries.length - 1 ||
            (entry.key !== event.key && entry.placeId !== event.placeId)
        )
      );
      continue;
    }

    const remaining = entries.filter(
      (entry) => entry.key !== event.key && entry.placeId !== event.placeId
    );
    entriesByList.set(event.listName, remaining);
  }

  let totalEntries = 0;
  for (const [listName, entries] of [...entriesByList].sort()) {
    const manifestEntries = entries.map(({ action, sequence, timestamp, ...entry }) =>
      entry
    );
    totalEntries += manifestEntries.length;
    if (options.dryRun) {
      console.log(`${listName}: ${manifestEntries.length} entries`);
    } else {
      await manifestWriteEntries(options.manifestDir, listName, manifestEntries);
    }
  }

  if (options.dryRun) {
    console.log(`would write ${entriesByList.size} manifest(s)`);
  } else {
    console.log(
      `wrote ${entriesByList.size} manifest(s) with ${totalEntries} entries to ${options.manifestDir}`
    );
  }
  if (partialSaveCount) {
    console.log(
      `${options.dryRun ? "would include" : "included"} ${partialSaveCount} note-field partial save(s)`
    );
  }
  if (conflicts) {
    console.warn(`resolved ${conflicts} source-key conflict(s) using the latest attempt`);
  }
}
