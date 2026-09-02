import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";
import getopts from "getopts";
import {
  distanceInMeters,
  placeReferenceFromUrl,
  sourceCoordinates,
} from "./gmaps-place.mjs";
import { manifestDirDefault, readManifests } from "./gmaps-manifest.mjs";

const matchFields = ["placeId", "note", "name"];

const diffColumns = [
  "status",
  "reason",
  "matchMethod",
  "candidateCount",
  "listName",
  "sourceListName",
  "sourceRow",
  "sourceName",
  "sourceUrl",
  "sourceMichelinUrl",
  "sourcePlaceId",
  "sourceNote",
  "sourceAddress",
  "sourceLocation",
  "sourceLatitude",
  "sourceLongitude",
  "takeoutListName",
  "takeoutFile",
  "takeoutRow",
  "takeoutTitle",
  "takeoutUrl",
  "takeoutPlaceId",
  "takeoutNote",
  "takeoutTags",
  "takeoutComment",
];

const noteColumns = [
  "status",
  "reason",
  "matchMethod",
  "membershipStatus",
  "listName",
  "sourceListName",
  "sourceRow",
  "sourceName",
  "sourceUrl",
  "sourceMichelinUrl",
  "sourcePlaceId",
  "sourceNote",
  "sourceAddress",
  "sourceLocation",
  "sourceLatitude",
  "sourceLongitude",
  "takeoutListName",
  "takeoutFile",
  "takeoutRow",
  "takeoutTitle",
  "takeoutUrl",
  "takeoutPlaceId",
  "takeoutNote",
  "takeoutTags",
  "takeoutComment",
];

const sourceChangeColumns = [
  "changeType",
  "changes",
  "matchMethod",
  "baselineListName",
  "baselineRow",
  "baselineName",
  "baselineUrl",
  "baselineMichelinUrl",
  "baselinePlaceId",
  "baselineNote",
  "baselineAddress",
  "baselineLocation",
  "baselineLatitude",
  "baselineLongitude",
  "currentListName",
  "currentRow",
  "currentName",
  "currentUrl",
  "currentMichelinUrl",
  "currentPlaceId",
  "currentNote",
  "currentAddress",
  "currentLocation",
  "currentLatitude",
  "currentLongitude",
];

const options = getopts(process.argv.slice(2), {
  alias: {
    source: ["s"],
    takeoutDir: ["takeout-dir", "t"],
    output: ["o"],
    report: ["r"],
    notesOutput: ["notes-output", "note-output", "n"],
    baselineSource: ["baseline-source", "baseline"],
    checkpoint: ["checkpoint", "c"],
    manifestDir: ["manifest-dir", "manifests"],
    changesOutput: [
      "changes-output",
      "source-changes-output",
      "source-change-output",
    ],
    help: ["h"],
  },
  default: {
    manifestDir: manifestDirDefault,
  },
});

if (options.help) {
  console.log(`Usage: node tools/audit-takeout.mjs \
  --source current.csv \
  --takeout-dir Takeout \
  --output audit.csv [--baseline-source imported.csv] \
  [--checkpoint checkpoint.json ...] [--changes-output changes.csv] \
  [--report audit.json] [--notes-output notes.csv] \
  [--manifest-dir local]

The current and baseline source CSVs must contain name, listName, and url
columns. Takeout must contain Google saved-list CSV files. Files that do not
resolve to one of the source list names are ignored, which allows a full
Takeout export to contain legacy or unrelated lists.

With --baseline-source, membership is audited against the source snapshot used
for the import. Checkpoints supply stable Google place IDs for that snapshot;
without a checkpoint ID, the audit falls back to notes and names. The current
source is used for a separate source-change report. For that report, unique
source rows with the same normalized name and description are treated as the
same restaurant, even when their address or coordinates changed. Without a
baseline source, successful per-list manifests under --manifest-dir supply
stable Google place IDs automatically.

Membership matching is one-to-one within each list, using unique place IDs,
notes, and normalized names in that order. A value is not matched when it is
duplicated on either side. Unique cross-list values are reported as wrong-list
relations. Unique close-enough name variants in the same list are accepted as
matches; name variants with multiple candidates remain ambiguous.

The output CSV contains only missing and extra memberships. Use
--notes-output to write a separate audit of current source notes that are
missing or different in Takeout. Use --changes-output to write source rows
that were added, removed, renamed, moved, or had metadata updated.
`);
  process.exit(0);
}

if (!options.source) throw new Error("must provide `--source`");
if (!options.takeoutDir) throw new Error("must provide `--takeout-dir`");
if (!options.output) throw new Error("must provide `--output`");

function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();
}

function normalizeName(value) {
  return normalizeText(value)
    .replace(/[øØ]/g, "o")
    .replace(/[łŁ]/g, "l")
    .replace(/[đĐ]/g, "d")
    .replace(/[ðÐ]/g, "d")
    .replace(/[þÞ]/g, "th")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function nameTokens(value) {
  return normalizeName(value).split(" ").filter(Boolean);
}

function tokensContainPhrase(tokens, phrase) {
  if (phrase.length > tokens.length) return false;
  return tokens.some((_, index) =>
    phrase.every((token, offset) => tokens[index + offset] === token)
  );
}

function extractPlaceId(url) {
  return placeReferenceFromUrl(url)?.placeId ?? "";
}

function rowPlaceId(row) {
  return row?.placeId || extractPlaceId(row?.url);
}

function sourceValue(row, field) {
  if (!row) return "";
  if (field === "name") return normalizeName(row.name);
  if (field === "placeId") return rowPlaceId(row);
  return normalizeText(row[field]);
}

function takeoutValue(row, field) {
  if (!row) return "";
  if (field === "name") return normalizeName(row.title);
  if (field === "placeId") return row.placeId || extractPlaceId(row.url);
  return normalizeText(row[field]);
}

function rowValue(row, side, field) {
  return side === "source"
    ? sourceValue(row, field)
    : takeoutValue(row, field);
}

function groupRows(rows, excluded, keyFn) {
  const groups = new Map();
  for (const row of rows) {
    if (excluded.has(row.id)) continue;
    const key = keyFn(row);
    if (!key) continue;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return groups;
}

function listValueKey(row, side, field) {
  const value = rowValue(row, side, field);
  return value ? `${row.listName}\u0000${value}` : "";
}

function matchUniqueWithinLists(
  sourceRows,
  takeoutRows,
  sourceMatched,
  takeoutMatched,
  field
) {
  const sourceGroups = groupRows(
    sourceRows,
    sourceMatched,
    (row) => listValueKey(row, "source", field)
  );
  const takeoutGroups = groupRows(
    takeoutRows,
    takeoutMatched,
    (row) => listValueKey(row, "takeout", field)
  );
  const pairs = [];

  for (const [key, sourceGroup] of sourceGroups) {
    const takeoutGroup = takeoutGroups.get(key) ?? [];
    if (sourceGroup.length !== 1 || takeoutGroup.length !== 1) continue;

    const source = sourceGroup[0];
    const takeout = takeoutGroup[0];
    sourceMatched.add(source.id);
    takeoutMatched.add(takeout.id);
    pairs.push({ source, takeout, field, kind: "same-list" });
  }

  return pairs;
}

function buildPrimaryMatches(sourceRows, takeoutRows) {
  const sourceMatched = new Set();
  const takeoutMatched = new Set();
  const pairs = [];
  const counts = {};

  for (const field of matchFields) {
    const fieldPairs = matchUniqueWithinLists(
      sourceRows,
      takeoutRows,
      sourceMatched,
      takeoutMatched,
      field
    );
    pairs.push(...fieldPairs);
    counts[field] = fieldPairs.length;
  }

  const nameVariantPairs = findUniqueNameVariantMatches(
    sourceRows,
    takeoutRows,
    sourceMatched,
    takeoutMatched
  );
  pairs.push(...nameVariantPairs);
  counts.nameVariant = nameVariantPairs.length;

  return { sourceMatched, takeoutMatched, pairs, counts };
}

function groupUnmatchedByValue(rows, side, matched, related, field) {
  const excluded = new Set([...matched, ...related]);
  return groupRows(rows, excluded, (row) => rowValue(row, side, field));
}

function findCrossListRelations(
  sourceRows,
  takeoutRows,
  sourceMatched,
  takeoutMatched
) {
  const sourceRelated = new Set();
  const takeoutRelated = new Set();
  const relations = [];

  for (const field of matchFields) {
    const sourceGroups = groupUnmatchedByValue(
      sourceRows,
      "source",
      sourceMatched,
      sourceRelated,
      field
    );
    const takeoutGroups = groupUnmatchedByValue(
      takeoutRows,
      "takeout",
      takeoutMatched,
      takeoutRelated,
      field
    );

    for (const [value, sourceGroup] of sourceGroups) {
      const takeoutGroup = takeoutGroups.get(value) ?? [];
      if (sourceGroup.length !== 1 || takeoutGroup.length !== 1) continue;

      const source = sourceGroup[0];
      const takeout = takeoutGroup[0];
      if (source.listName === takeout.listName) continue;

      sourceRelated.add(source.id);
      takeoutRelated.add(takeout.id);
      relations.push({ source, takeout, field, kind: "wrong-list" });
    }
  }

  return { relations, sourceRelated, takeoutRelated };
}

function namesHaveVariantMatch(sourceName, takeoutName) {
  const source = normalizeName(sourceName);
  const takeout = normalizeName(takeoutName);
  if (!source || !takeout || source === takeout) return false;

  const sourceTokens = nameTokens(sourceName);
  const takeoutTokens = nameTokens(takeoutName);
  if (sourceTokens.length < 2 || takeoutTokens.length < 2) return false;

  const sourceSet = new Set(sourceTokens);
  const takeoutSet = new Set(takeoutTokens);
  const sourceSubset = [...sourceSet].every((token) => takeoutSet.has(token));
  const takeoutSubset = [...takeoutSet].every((token) => sourceSet.has(token));
  const tokenDifference = Math.abs(sourceSet.size - takeoutSet.size);
  const sourcePhraseInTakeout = tokensContainPhrase(
    takeoutTokens,
    sourceTokens
  );
  const takeoutPhraseInSource = tokensContainPhrase(
    sourceTokens,
    takeoutTokens
  );

  return (
    (sourceSubset || takeoutSubset) &&
    (tokenDifference <= 2 || sourcePhraseInTakeout || takeoutPhraseInSource)
  );
}

function findUniqueNameVariantMatches(
  sourceRows,
  takeoutRows,
  sourceMatched,
  takeoutMatched
) {
  const sourceExcluded = new Set(sourceMatched);
  const takeoutExcluded = new Set(takeoutMatched);
  const sourceAvailable = sourceRows.filter(
    (row) => !sourceExcluded.has(row.id)
  );
  const takeoutAvailable = takeoutRows.filter(
    (row) => !takeoutExcluded.has(row.id)
  );
  const relations = [];
  const sourceVariantIds = new Set();
  const takeoutVariantIds = new Set();

  for (const source of sourceAvailable) {
    if (sourceVariantIds.has(source.id)) continue;
    const candidates = takeoutAvailable.filter(
      (takeout) =>
        !takeoutVariantIds.has(takeout.id) &&
        takeout.listName === source.listName &&
        namesHaveVariantMatch(source.name, takeout.title)
    );
    if (candidates.length !== 1) continue;

    const takeout = candidates[0];
    const reciprocal = sourceAvailable.filter(
      (candidate) =>
        !sourceVariantIds.has(candidate.id) &&
        candidate.listName === takeout.listName &&
        namesHaveVariantMatch(candidate.name, takeout.title)
    );
    if (reciprocal.length !== 1) continue;

    sourceVariantIds.add(source.id);
    takeoutVariantIds.add(takeout.id);
    sourceMatched.add(source.id);
    takeoutMatched.add(takeout.id);
    relations.push({
      source,
      takeout,
      field: "name-variant",
      kind: "same-list",
    });
  }

  return relations;
}

function resolveListName(fileStem, sourceListNames) {
  if (sourceListNames.has(fileStem)) return fileStem;

  const candidates = [...sourceListNames].filter((name) =>
    name.startsWith(fileStem)
  );
  return candidates.length === 1 ? candidates[0] : null;
}

async function readSource(filename) {
  const rows = parse(await readFile(filename), {
    bom: true,
    columns: true,
    relax_column_count: true,
    skip_empty_lines: true,
  });
  for (const [index, row] of rows.entries()) {
    for (const column of ["name", "listName", "url"]) {
      if (!row[column]) {
        throw new Error(`source row ${index + 2} is missing \`${column}\``);
      }
    }
  }
  return rows.map((row, index) => ({
    ...row,
    id: `source:${index}`,
    sourceRow: index + 2,
    listName: row.listName,
    name: row.name,
    note: row.note ?? "",
    url: row.url,
  }));
}

function membershipKey(row) {
  return `${row.listName}\t${row.name}\t${row.url}`;
}

function attemptPlaceId(attempt) {
  return (
    attempt.placeId ||
    attempt.verifiedPlace?.placeId ||
    extractPlaceId(attempt.googleUrl) ||
    extractPlaceId(attempt.verifiedPlace?.googleUrl) ||
    ""
  );
}

async function readCheckpointFile(filename) {
  const checkpoint = JSON.parse(await readFile(filename, "utf8"));
  if (!checkpoint || typeof checkpoint !== "object") {
    throw new Error(`checkpoint is not an object: ${filename}`);
  }
  return {
    ...checkpoint,
    attempts: Array.isArray(checkpoint.attempts) ? checkpoint.attempts : [],
  };
}

async function readCheckpointMappings(filenames) {
  const entriesByKey = new Map();
  const snapshots = [];

  for (const filename of filenames) {
    const checkpoint = await readCheckpointFile(filename);
    snapshots.push({
      filename,
      sourceSnapshot: checkpoint.sourceSnapshot ?? null,
      attemptCount: checkpoint.attempts.length,
    });

    for (const attempt of checkpoint.attempts) {
      if (
        attempt.status !== "succeeded" ||
        Object.hasOwn(attempt, "removed") ||
        !attempt.key
      ) {
        continue;
      }

      const placeId = attemptPlaceId(attempt);
      if (!placeId) continue;

      const entries = entriesByKey.get(attempt.key) ?? [];
      entries.push({
        placeId,
        googleUrl: attempt.googleUrl ?? attempt.verifiedPlace?.googleUrl ?? "",
        checkpointFile: filename,
        finishedAt: attempt.finishedAt ?? "",
      });
      entriesByKey.set(attempt.key, entries);
    }
  }

  const mappings = new Map();
  const conflicts = [];
  for (const [key, entries] of entriesByKey) {
    const placeIds = [...new Set(entries.map((entry) => entry.placeId))];
    if (placeIds.length !== 1) {
      conflicts.push({
        key,
        placeIds,
        checkpoints: [...new Set(entries.map((entry) => entry.checkpointFile))],
      });
      continue;
    }

    const latest = [...entries].sort((first, second) =>
      String(first.finishedAt).localeCompare(String(second.finishedAt))
    ).at(-1);
    mappings.set(key, {
      placeId: placeIds[0],
      googleUrl: latest.googleUrl,
      checkpointFile: latest.checkpointFile,
      finishedAt: latest.finishedAt,
    });
  }

  return { mappings, conflicts, snapshots };
}

function addCheckpointPlaceIds(rows, mappings) {
  return rows.map((row) => {
    if (rowPlaceId(row)) return row;

    const mapping = mappings.get(membershipKey(row));
    if (!mapping) return row;

    return {
      ...row,
      placeId: mapping.placeId,
      checkpointGoogleUrl: mapping.googleUrl,
      checkpointFile: mapping.checkpointFile,
    };
  });
}

function headerIndex(header, name) {
  return header.findIndex((value) => normalizeText(value) === name);
}

async function readTakeout(takeoutDir, sourceListNames) {
  const files = (await readdir(takeoutDir, { withFileTypes: true }))
    .filter(
      (entry) =>
        entry.isFile() && entry.name.toLocaleLowerCase().endsWith(".csv")
    )
    .map((entry) => entry.name)
    .sort();
  const rows = [];
  const listCounts = new Map();
  const ignoredFiles = [];

  for (const file of files) {
    const fileStem = file.slice(0, -4);
    const listName = resolveListName(fileStem, sourceListNames);
    if (!listName) {
      ignoredFiles.push(file);
      continue;
    }

    const records = parse(await readFile(path.join(takeoutDir, file)), {
      bom: true,
      relax_column_count: true,
      skip_empty_lines: false,
    });
    const headerRow = records.findIndex((record) => {
      const titleColumn = headerIndex(record, "title");
      const urlColumn = headerIndex(record, "url");
      return titleColumn >= 0 && urlColumn >= 0;
    });
    if (headerRow < 0) {
      throw new Error(`could not find a Title,Note,URL header in ${file}`);
    }

    const header = records[headerRow];
    const columnTitle = headerIndex(header, "title");
    const columnNote = headerIndex(header, "note");
    const columnUrl = headerIndex(header, "url");
    const columnTags = headerIndex(header, "tags");
    const columnComment = headerIndex(header, "comment");
    let listCount = 0;

    for (let index = headerRow + 1; index < records.length; index += 1) {
      const record = records[index];
      const title = record[columnTitle] ?? "";
      const note = columnNote >= 0 ? record[columnNote] ?? "" : "";
      const url = record[columnUrl] ?? "";
      const tags = columnTags >= 0 ? record[columnTags] ?? "" : "";
      const comment =
        columnComment >= 0 ? record[columnComment] ?? "" : "";
      if (![title, note, url, tags, comment].some(Boolean)) continue;

      rows.push({
        id: `takeout:${rows.length}`,
        takeoutFile: file,
        takeoutRow: index + 1,
        listName,
        rawListName: fileStem,
        title,
        note,
        url,
        tags,
        comment,
      });
      listCount += 1;
    }
    listCounts.set(listName, (listCounts.get(listName) ?? 0) + listCount);
  }

  return { rows, files, ignoredFiles, listCounts };
}

const sourceChangeMatchDistanceM = 100;
const sourceCoordinateChangeDistanceM = 10;

function sourceIdentityValue(row, field) {
  if (field === "placeId") return rowPlaceId(row);
  if (field === "michelinUrl") return normalizeText(row.michelinUrl);
  if (field === "name") return normalizeName(row.name);
  if (field === "name+address") {
    const name = normalizeName(row.name);
    const address = normalizeText(row.address);
    return name && address ? `${name}\u0000${address}` : "";
  }
  if (field === "name+note") {
    const name = normalizeName(row.name);
    const note = normalizeText(row.note);
    return name && note ? `${name}\u0000${note}` : "";
  }
  return "";
}

function sourceRowsWithinMatchDistance(first, second) {
  const firstCoordinates = sourceCoordinates(first);
  const secondCoordinates = sourceCoordinates(second);
  if (!firstCoordinates || !secondCoordinates) return true;
  return (
    distanceInMeters(firstCoordinates, secondCoordinates) <=
    sourceChangeMatchDistanceM
  );
}

function matchUniqueSourceRows(
  baselineRows,
  currentRows,
  baselineMatched,
  currentMatched,
  field,
  candidateFilter = () => true
) {
  const baselineGroups = groupRows(
    baselineRows,
    baselineMatched,
    (row) => sourceIdentityValue(row, field)
  );
  const currentGroups = groupRows(
    currentRows,
    currentMatched,
    (row) => sourceIdentityValue(row, field)
  );
  const pairs = [];

  for (const [value, baselineGroup] of baselineGroups) {
    if (baselineGroup.length !== 1) continue;

    const currentCandidates = (currentGroups.get(value) ?? []).filter(
      (current) => candidateFilter(baselineGroup[0], current)
    );
    if (currentCandidates.length !== 1) continue;

    const baseline = baselineGroup[0];
    const current = currentCandidates[0];
    baselineMatched.add(baseline.id);
    currentMatched.add(current.id);
    pairs.push({ baseline, current, matchMethod: field });
  }

  return pairs;
}

function matchUniqueSourceCoordinates(
  baselineRows,
  currentRows,
  baselineMatched,
  currentMatched,
  candidateFilter = () => true
) {
  const baselineAvailable = baselineRows.filter(
    (row) => !baselineMatched.has(row.id) && sourceCoordinates(row)
  );
  const currentAvailable = currentRows.filter(
    (row) => !currentMatched.has(row.id) && sourceCoordinates(row)
  );
  const pairs = [];

  for (const baseline of baselineAvailable) {
    const currentCandidates = currentAvailable.filter(
      (current) =>
        !currentMatched.has(current.id) &&
        candidateFilter(baseline, current) &&
        sourceRowsWithinMatchDistance(baseline, current)
    );
    if (currentCandidates.length !== 1) continue;

    const current = currentCandidates[0];
    const baselineCandidates = baselineAvailable.filter(
      (candidate) =>
        !baselineMatched.has(candidate.id) &&
        candidateFilter(candidate, current) &&
        sourceRowsWithinMatchDistance(candidate, current)
    );
    if (baselineCandidates.length !== 1) continue;

    baselineMatched.add(baseline.id);
    currentMatched.add(current.id);
    pairs.push({ baseline, current, matchMethod: "coordinates" });
  }

  return pairs;
}

function sourceChangeDifferences(baseline, current, compareMichelinUrl) {
  const changes = [];
  if (normalizeText(baseline.listName) !== normalizeText(current.listName)) {
    changes.push("listName");
  }
  if (normalizeName(baseline.name) !== normalizeName(current.name)) {
    changes.push("name");
  }
  if (
    compareMichelinUrl &&
    normalizeText(baseline.michelinUrl) !== normalizeText(current.michelinUrl)
  ) {
    changes.push("michelinUrl");
  }
  if (normalizeText(baseline.note) !== normalizeText(current.note)) {
    changes.push("note");
  }
  if (normalizeText(baseline.address) !== normalizeText(current.address)) {
    changes.push("address");
  }
  if (normalizeText(baseline.location) !== normalizeText(current.location)) {
    changes.push("location");
  }

  const baselineCoordinates = sourceCoordinates(baseline);
  const currentCoordinates = sourceCoordinates(current);
  if (baselineCoordinates && currentCoordinates) {
    if (
      distanceInMeters(baselineCoordinates, currentCoordinates) >
      sourceCoordinateChangeDistanceM
    ) {
      changes.push("coordinates");
    }
  } else if (Boolean(baselineCoordinates) !== Boolean(currentCoordinates)) {
    changes.push("coordinates");
  }

  return changes;
}

function sourceChangeFields(prefix, row) {
  return {
    [`${prefix}ListName`]: row?.listName ?? "",
    [`${prefix}Row`]: row?.sourceRow ?? "",
    [`${prefix}Name`]: row?.name ?? "",
    [`${prefix}Url`]: row?.url ?? "",
    [`${prefix}MichelinUrl`]: row?.michelinUrl ?? "",
    [`${prefix}PlaceId`]: rowPlaceId(row),
    [`${prefix}Note`]: row?.note ?? "",
    [`${prefix}Address`]: row?.address ?? "",
    [`${prefix}Location`]: row?.location ?? "",
    [`${prefix}Latitude`]: row?.latitude ?? "",
    [`${prefix}Longitude`]: row?.longitude ?? "",
  };
}

function buildSourceChangeRow(
  changeType,
  changes,
  matchMethod,
  baseline,
  current
) {
  const baselineFields = sourceChangeFields("baseline", baseline);
  const currentFields = sourceChangeFields("current", current);
  return {
    changeType,
    changes: changes.join(","),
    matchMethod,
    ...baselineFields,
    ...currentFields,
  };
}

function matchSourceRows(
  baselineRows,
  currentRows,
  candidateFilter = () => true
) {
  const baselineMatched = new Set();
  const currentMatched = new Set();
  const pairs = [];
  const matchSteps = [
    ["placeId", candidateFilter],
    ["michelinUrl", candidateFilter],
    ["name+note", candidateFilter],
    ["name+address", candidateFilter],
  ];

  for (const [field, candidateFilter] of matchSteps) {
    pairs.push(
      ...matchUniqueSourceRows(
        baselineRows,
        currentRows,
        baselineMatched,
        currentMatched,
        field,
        candidateFilter
      )
    );
  }
  pairs.push(
    ...matchUniqueSourceCoordinates(
      baselineRows,
      currentRows,
      baselineMatched,
      currentMatched,
      candidateFilter
    )
  );
  pairs.push(
    ...matchUniqueSourceRows(
      baselineRows,
      currentRows,
      baselineMatched,
      currentMatched,
      "name",
      (baseline, current) =>
        candidateFilter(baseline, current) &&
        sourceRowsWithinMatchDistance(baseline, current)
    )
  );

  return { baselineMatched, currentMatched, pairs };
}

function addManifestPlaceIds(rows, manifestRows) {
  const sameList = (baseline, current) =>
    normalizeText(baseline.listName) === normalizeText(current.listName);
  const sameListMatches = matchSourceRows(manifestRows, rows, sameList);
  const remainingMatches = matchSourceRows(
    manifestRows.filter((row) => !sameListMatches.baselineMatched.has(row.id)),
    rows.filter((row) => !sameListMatches.currentMatched.has(row.id))
  );
  const pairs = [...sameListMatches.pairs, ...remainingMatches.pairs];
  const manifestByCurrentId = new Map(
    pairs
      .filter((pair) => rowPlaceId(pair.baseline))
      .map((pair) => [pair.current.id, pair.baseline])
  );

  return rows.map((row) => {
    if (rowPlaceId(row)) return row;

    const manifest = manifestByCurrentId.get(row.id);
    if (!manifest) return row;

    return {
      ...row,
      placeId: rowPlaceId(manifest),
      manifestGoogleUrl: manifest.googleUrl,
      manifestFile: manifest.manifestFile,
    };
  });
}

function buildSourceChanges(baselineRows, currentRows) {
  const { baselineMatched, currentMatched, pairs } = matchSourceRows(
    baselineRows,
    currentRows
  );

  const compareMichelinUrl = baselineRows.some((row) =>
    normalizeText(row.michelinUrl)
  );
  const baselineToCurrent = new Map();
  const currentToBaseline = new Map();
  const pairedRows = pairs.map((pair) => {
    const current =
      rowPlaceId(pair.current) || !rowPlaceId(pair.baseline)
        ? pair.current
        : {
            ...pair.current,
            placeId: rowPlaceId(pair.baseline),
            checkpointGoogleUrl: pair.baseline.checkpointGoogleUrl,
            checkpointFile: pair.baseline.checkpointFile,
          };
    const paired = { ...pair, current };
    baselineToCurrent.set(pair.baseline.id, current);
    currentToBaseline.set(current.id, pair.baseline);
    return paired;
  });

  const rows = [];
  for (const pair of pairedRows) {
    const changes = sourceChangeDifferences(
      pair.baseline,
      pair.current,
      compareMichelinUrl
    );
    if (!changes.length) continue;
    rows.push(
      buildSourceChangeRow(
        "updated",
        changes,
        pair.matchMethod,
        pair.baseline,
        pair.current
      )
    );
  }

  for (const baseline of baselineRows) {
    if (baselineMatched.has(baseline.id)) continue;
    rows.push(
      buildSourceChangeRow(
        "removed-from-source",
        [],
        "",
        baseline,
        null
      )
    );
  }
  for (const current of currentRows) {
    if (currentMatched.has(current.id)) continue;
    rows.push(
      buildSourceChangeRow("added-to-source", [], "", null, current)
    );
  }

  return {
    pairs: pairedRows,
    baselineToCurrent,
    currentToBaseline,
    rows,
    counts: {
      baselineMatched: baselineMatched.size,
      currentMatched: currentMatched.size,
      baselineUnmatched: baselineRows.length - baselineMatched.size,
      currentUnmatched: currentRows.length - currentMatched.size,
    },
  };
}

function addInheritedPlaceIds(rows, sourceChanges) {
  return rows.map((row) => {
    if (rowPlaceId(row)) return row;

    const baseline = sourceChanges.currentToBaseline.get(row.id);
    if (!baseline || !rowPlaceId(baseline)) return row;

    return {
      ...row,
      placeId: rowPlaceId(baseline),
      checkpointGoogleUrl: baseline.checkpointGoogleUrl,
      checkpointFile: baseline.checkpointFile,
    };
  });
}

function findCandidateEvidence(
  row,
  counterpartRows,
  counterpartMatched,
  counterpartRelated,
  side
) {
  const excluded = new Set([...counterpartMatched, ...counterpartRelated]);
  const counterpartSide = side === "source" ? "takeout" : "source";

  for (const field of matchFields) {
    const value = rowValue(row, side, field);
    if (!value) continue;
    const candidates = counterpartRows.filter(
      (candidate) =>
        !excluded.has(candidate.id) &&
        rowValue(candidate, counterpartSide, field) === value
    );
    if (!candidates.length) continue;
    if (candidates.length > 1) {
      return {
        field,
        candidateCount: candidates.length,
        reason: field === "name" ? "ambiguous-name" : "ambiguous-match",
      };
    }

    const candidate = candidates[0];
    return {
      field,
      candidate,
      candidateCount: 1,
      reason:
        candidate.listName === row.listName
          ? "duplicate-or-variant"
          : "wrong-list",
    };
  }

  return null;
}

function sourceFields(source) {
  return {
    sourceListName: source?.listName ?? "",
    sourceRow: source?.sourceRow ?? "",
    sourceName: source?.name ?? "",
    sourceUrl: source?.url ?? "",
    sourceMichelinUrl: source?.michelinUrl ?? "",
    sourcePlaceId: rowPlaceId(source),
    sourceNote: source?.note ?? "",
    sourceAddress: source?.address ?? "",
    sourceLocation: source?.location ?? "",
    sourceLatitude: source?.latitude ?? "",
    sourceLongitude: source?.longitude ?? "",
  };
}

function takeoutFields(takeout) {
  return {
    takeoutListName: takeout?.listName ?? "",
    takeoutFile: takeout?.takeoutFile ?? "",
    takeoutRow: takeout?.takeoutRow ?? "",
    takeoutTitle: takeout?.title ?? "",
    takeoutUrl: takeout?.url ?? "",
    takeoutPlaceId: takeoutValue(takeout, "placeId"),
    takeoutNote: takeout?.note ?? "",
    takeoutTags: takeout?.tags ?? "",
    takeoutComment: takeout?.comment ?? "",
  };
}

function buildDiffRow(status, reason, matchMethod, candidateCount, source, takeout) {
  return {
    status,
    reason,
    matchMethod,
    candidateCount,
    listName: source?.listName ?? takeout?.listName ?? "",
    ...sourceFields(source),
    ...takeoutFields(takeout),
  };
}

function buildDiffRows(
  sourceRows,
  takeoutRows,
  sourceMatched,
  takeoutMatched,
  sourceRelated,
  takeoutRelated,
  relationBySource,
  relationByTakeout
) {
  const rows = [];

  for (const source of sourceRows) {
    if (sourceMatched.has(source.id)) continue;

    const relation = relationBySource.get(source.id);
    const evidence = relation
      ? null
      : findCandidateEvidence(
          source,
          takeoutRows,
          takeoutMatched,
          takeoutRelated,
          "source"
        );
    const takeout = relation?.takeout ?? evidence?.candidate ?? null;
    const reason =
      relation?.kind === "wrong-list"
        ? "wrong-list"
        : relation?.kind === "name-variant"
          ? "ambiguous-name"
          : evidence?.reason ?? "missing-from-list";
    rows.push(
      buildDiffRow(
        "missing",
        reason,
        relation?.field ?? evidence?.field ?? "",
        relation ? 1 : evidence?.candidateCount ?? 0,
        source,
        takeout
      )
    );
  }

  for (const takeout of takeoutRows) {
    if (takeoutMatched.has(takeout.id)) continue;

    const relation = relationByTakeout.get(takeout.id);
    const evidence = relation
      ? null
      : findCandidateEvidence(
          takeout,
          sourceRows,
          sourceMatched,
          sourceRelated,
          "takeout"
        );
    const source = relation?.source ?? evidence?.candidate ?? null;
    const reason =
      relation?.kind === "wrong-list"
        ? "wrong-list"
        : relation?.kind === "name-variant"
          ? "ambiguous-name"
          : evidence?.reason ?? "extra-in-list";
    rows.push(
      buildDiffRow(
        "extra",
        reason,
        relation?.field ?? evidence?.field ?? "",
        relation ? 1 : evidence?.candidateCount ?? 0,
        source,
        takeout
      )
    );
  }

  return rows;
}

function noteIssueReason(source, takeout, membershipStatus) {
  const sourceNote = normalizeText(source.note);
  const takeoutNote = normalizeText(takeout.note);
  if (!sourceNote || sourceNote === takeoutNote) return null;
  if (!takeoutNote) {
    return membershipStatus === "possible-name-variant"
      ? "possible-name-variant-missing-note"
      : "missing-note";
  }
  return membershipStatus === "possible-name-variant"
    ? "possible-name-variant-note-mismatch"
    : "note-mismatch";
}

function buildNoteRows(
  primaryPairs,
  relations,
  currentSourceByBaselineId = new Map()
) {
  const rows = [];
  const pairs = [
    ...primaryPairs.map((pair) => ({
      ...pair,
      source: currentSourceByBaselineId.get(pair.source.id) ?? pair.source,
      membershipStatus: "matched",
    })),
    ...relations.map((relation) => ({
      ...relation,
      source:
        currentSourceByBaselineId.get(relation.source.id) ?? relation.source,
      membershipStatus:
        relation.kind === "wrong-list"
          ? "wrong-list"
          : "possible-name-variant",
    })),
  ];

  for (const pair of pairs) {
    const reason = noteIssueReason(
      pair.source,
      pair.takeout,
      pair.membershipStatus
    );
    if (!reason) continue;
    rows.push({
      status: "note-issue",
      reason,
      matchMethod: pair.field,
      membershipStatus: pair.membershipStatus,
      listName: pair.source.listName,
      ...sourceFields(pair.source),
      ...takeoutFields(pair.takeout),
    });
  }

  return rows;
}

function indexRelations(relations) {
  const bySource = new Map();
  const byTakeout = new Map();
  for (const relation of relations) {
    bySource.set(relation.source.id, relation);
    byTakeout.set(relation.takeout.id, relation);
  }
  return { bySource, byTakeout };
}

function countBy(rows, key) {
  const counts = new Map();
  for (const row of rows) {
    const value = row[key];
    if (!value) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return Object.fromEntries(counts);
}

function countByList(rows) {
  return countBy(rows, "listName");
}

function optionValues(value) {
  if (value === undefined || value === null) return [];
  return (Array.isArray(value) ? value : [value]).filter(Boolean);
}

async function writeCsv(filename, rows, columns) {
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, stringify(rows, { columns, header: true }));
}

async function main() {
  const currentSourceRowsRaw = await readSource(options.source);
  const baselineSourceRowsRaw = options.baselineSource
    ? await readSource(options.baselineSource)
    : currentSourceRowsRaw;
  const checkpointFiles = optionValues(options.checkpoint);
  const checkpoints = await readCheckpointMappings(checkpointFiles);
  const manifests = options.baselineSource
    ? { files: [], rows: [] }
    : await readManifests(options.manifestDir);
  const baselineSourceRows = addCheckpointPlaceIds(
    baselineSourceRowsRaw,
    checkpoints.mappings
  );
  const currentSourceRowsDirect = addCheckpointPlaceIds(
    currentSourceRowsRaw,
    checkpoints.mappings
  );
  const sourceChanges = options.baselineSource
    ? buildSourceChanges(baselineSourceRows, currentSourceRowsDirect)
    : {
        pairs: [],
        baselineToCurrent: new Map(),
        currentToBaseline: new Map(),
        rows: [],
        counts: {
          baselineMatched: currentSourceRowsDirect.length,
          currentMatched: currentSourceRowsDirect.length,
          baselineUnmatched: 0,
          currentUnmatched: 0,
        },
      };
  const currentSourceRows = options.baselineSource
    ? addInheritedPlaceIds(currentSourceRowsDirect, sourceChanges)
    : addManifestPlaceIds(currentSourceRowsDirect, manifests.rows);
  const membershipSourceRows = options.baselineSource
    ? baselineSourceRows
    : currentSourceRows;
  const sourceListNames = new Set([
    ...membershipSourceRows.map((row) => row.listName),
    ...currentSourceRows.map((row) => row.listName),
  ]);
  const {
    rows: takeoutRows,
    files,
    ignoredFiles,
    listCounts,
  } = await readTakeout(options.takeoutDir, sourceListNames);
  const primary = buildPrimaryMatches(membershipSourceRows, takeoutRows);
  const crossList = findCrossListRelations(
    membershipSourceRows,
    takeoutRows,
    primary.sourceMatched,
    primary.takeoutMatched
  );
  const relations = crossList.relations;
  const relationIndexes = indexRelations(relations);
  const diff = buildDiffRows(
    membershipSourceRows,
    takeoutRows,
    primary.sourceMatched,
    primary.takeoutMatched,
    crossList.sourceRelated,
    crossList.takeoutRelated,
    relationIndexes.bySource,
    relationIndexes.byTakeout
  );
  const currentSourceById = new Map(
    currentSourceRows.map((row) => [row.id, row])
  );
  const currentSourceByBaselineId = new Map(
    sourceChanges.pairs.map((pair) => [
      pair.baseline.id,
      currentSourceById.get(pair.current.id) ?? pair.current,
    ])
  );
  const notes = buildNoteRows(
    primary.pairs,
    relations,
    currentSourceByBaselineId
  );
  const report = {
    source: options.source,
    baselineSource: options.baselineSource ?? null,
    takeoutDir: options.takeoutDir,
    takeoutFiles: files,
    ignoredTakeoutFiles: ignoredFiles,
    checkpointFiles,
    checkpointSnapshots: checkpoints.snapshots,
    checkpointMappings: checkpoints.mappings.size,
    checkpointConflicts: checkpoints.conflicts,
    manifestDir: options.manifestDir,
    manifestFiles: manifests.files,
    manifestRows: manifests.rows.length,
    sourceRows: membershipSourceRows.length,
    baselineSourceRows: baselineSourceRows.length,
    currentSourceRows: currentSourceRows.length,
    stablePlaceIdRows: membershipSourceRows.filter((row) => rowPlaceId(row))
      .length,
    takeoutPlaceIdRows: takeoutRows.filter((row) =>
      takeoutValue(row, "placeId")
    ).length,
    takeoutRows: takeoutRows.length,
    matchedRows: primary.sourceMatched.size,
    missingRows: diff.filter((row) => row.status === "missing").length,
    extraRows: diff.filter((row) => row.status === "extra").length,
    ambiguousMembershipRows: diff.filter((row) =>
      ["ambiguous-match", "ambiguous-name"].includes(row.reason)
    ).length,
    noteIssueRows: notes.length,
    matches: primary.counts,
    crossListRelations: crossList.relations.length,
    reasonCounts: countBy(diff, "reason"),
    missingReasonCounts: countBy(
      diff.filter((row) => row.status === "missing"),
      "reason"
    ),
    extraReasonCounts: countBy(
      diff.filter((row) => row.status === "extra"),
      "reason"
    ),
    noteReasonCounts: countBy(notes, "reason"),
    sourceCounts: countByList(membershipSourceRows),
    currentSourceCounts: countByList(currentSourceRows),
    takeoutCounts: Object.fromEntries(listCounts),
    missingCounts: countByList(
      diff.filter((row) => row.status === "missing")
    ),
    extraCounts: countByList(diff.filter((row) => row.status === "extra")),
    noteIssueCounts: countByList(notes),
    sourceChangeRows: sourceChanges.rows.length,
    sourceChangeCounts: countBy(sourceChanges.rows, "changeType"),
    sourceChangeReasonCounts: countBy(sourceChanges.rows, "changes"),
    sourceChangeMatchCounts: countBy(sourceChanges.rows, "matchMethod"),
    sourceChangeMatching: sourceChanges.counts,
  };

  await writeCsv(options.output, diff, diffColumns);
  if (options.report) {
    await mkdir(path.dirname(options.report), { recursive: true });
    await writeFile(options.report, `${JSON.stringify(report, null, 2)}\n`);
  }
  if (options.notesOutput) {
    await writeCsv(options.notesOutput, notes, noteColumns);
  }
  if (options.changesOutput) {
    await writeCsv(options.changesOutput, sourceChanges.rows, sourceChangeColumns);
  }

  console.log(
    `audited ${membershipSourceRows.length} source rows against ${takeoutRows.length} Takeout rows`
  );
  console.log(`matched: ${primary.sourceMatched.size}`);
  console.log(`missing: ${report.missingRows}`);
  console.log(`extra: ${report.extraRows}`);
  console.log(`ambiguous membership rows: ${report.ambiguousMembershipRows}`);
  console.log(`note issues: ${report.noteIssueRows}`);
  if (ignoredFiles.length) {
    console.log(`ignored Takeout files: ${ignoredFiles.length}`);
  }
  console.log(`wrote: ${options.output}`);
  if (options.report) console.log(`wrote: ${options.report}`);
  if (options.notesOutput) console.log(`wrote: ${options.notesOutput}`);
  if (options.changesOutput) console.log(`wrote: ${options.changesOutput}`);
}

await main();
