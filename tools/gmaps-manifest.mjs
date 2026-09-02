import {
  mkdir,
  readdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { placeReferenceFromUrl } from "./gmaps-place.mjs";

export const manifestDirDefault = "local";
export const manifestVersion = 1;

export function sourceKey({ name, url, listName }) {
  return `${listName}\t${name}\t${url}`;
}

function placeIdFrom(value) {
  return (
    value?.placeId ||
    placeReferenceFromUrl(value?.googleUrl)?.placeId ||
    placeReferenceFromUrl(value?.url)?.placeId ||
    ""
  );
}

function manifestFilename(listName) {
  const filename = String(listName ?? "")
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_");
  if (!filename) throw new Error("cannot create a manifest for an empty list name");
  return `${filename}.json`;
}

export function manifestPath(manifestDir, listName) {
  return path.join(manifestDir || manifestDirDefault, manifestFilename(listName));
}

export function manifestEntryFromRow(row, place, savedAt = new Date().toISOString()) {
  const placeId = placeIdFrom(place);
  if (!placeId) {
    throw new Error(`cannot create a manifest entry without a place ID for ${row.name}`);
  }

  return {
    key: sourceKey(row),
    listName: row.listName,
    name: row.name,
    url: row.url,
    michelinUrl: row.michelinUrl ?? "",
    note: row.note ?? "",
    address: row.address ?? "",
    location: row.location ?? "",
    latitude: row.latitude ?? "",
    longitude: row.longitude ?? "",
    placeId,
    googleUrl: place?.googleUrl ?? place?.url ?? "",
    savedAt,
  };
}

export function manifestEntryFromAttempt(attempt) {
  const placeId = placeIdFrom({
    placeId: attempt.placeId || attempt.verifiedPlace?.placeId,
    googleUrl: attempt.googleUrl || attempt.verifiedPlace?.googleUrl,
  });
  if (!placeId || !attempt.listName || !attempt.name || !attempt.url) {
    return null;
  }

  return {
    key: attempt.key || sourceKey(attempt),
    listName: attempt.listName,
    name: attempt.name,
    url: attempt.url,
    michelinUrl: attempt.michelinUrl ?? "",
    note: attempt.note ?? "",
    address: attempt.address ?? "",
    location: attempt.location ?? "",
    latitude: attempt.latitude ?? "",
    longitude: attempt.longitude ?? "",
    placeId,
    googleUrl: attempt.googleUrl || attempt.verifiedPlace?.googleUrl || "",
    savedAt: attempt.finishedAt || attempt.startedAt || "",
  };
}

async function manifestRead(filename) {
  try {
    const manifest = JSON.parse(await readFile(filename, "utf8"));
    if (
      !manifest ||
      manifest.version !== manifestVersion ||
      typeof manifest.listName !== "string" ||
      !Array.isArray(manifest.entries)
    ) {
      throw new Error(`invalid manifest: ${filename}`);
    }
    return { exists: true, manifest };
  } catch (error) {
    if (error.code === "ENOENT") return { exists: false, manifest: null };
    throw error;
  }
}

async function manifestWrite(filename, listName, entries) {
  const sortedEntries = [...entries].sort((first, second) =>
    String(first.key).localeCompare(String(second.key))
  );
  const manifest = {
    version: manifestVersion,
    listName,
    updatedAt: new Date().toISOString(),
    entries: sortedEntries,
  };
  const temporaryFile = `${filename}.tmp`;
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(temporaryFile, `${JSON.stringify(manifest, null, 2)}\n`);
  await rename(temporaryFile, filename);
}

export async function manifestWriteEntries(manifestDir, listName, entries) {
  await manifestWrite(manifestPath(manifestDir, listName), listName, entries);
}

export async function manifestUpsertEntry(manifestDir, row, place, savedAt) {
  const filename = manifestPath(manifestDir, row.listName);
  const { manifest } = await manifestRead(filename);
  const entry = manifestEntryFromRow(row, place, savedAt);
  const entries = (manifest?.entries ?? []).filter(
    (current) => current.key !== entry.key && current.placeId !== entry.placeId
  );
  entries.push(entry);
  await manifestWrite(filename, row.listName, entries);
}

export async function manifestRemoveEntry(manifestDir, row, place) {
  const filename = manifestPath(manifestDir, row.listName);
  const { exists, manifest } = await manifestRead(filename);
  if (!exists) return false;

  const placeId = placeIdFrom(place) || placeIdFrom(row);
  const key = sourceKey(row);
  const entries = manifest.entries.filter(
    (entry) => entry.key !== key && (!placeId || entry.placeId !== placeId)
  );
  if (entries.length === manifest.entries.length) return false;

  await manifestWrite(filename, manifest.listName, entries);
  return true;
}

export async function readManifests(manifestDir = manifestDirDefault) {
  let entries;
  try {
    entries = await readdir(manifestDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return { files: [], rows: [] };
    }
    throw error;
  }

  const files = [];
  const rows = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;

    const filename = path.join(manifestDir, entry.name);
    const { manifest } = await manifestRead(filename);
    files.push(filename);
    for (const [index, manifestEntry] of manifest.entries.entries()) {
      if (!manifestEntry.placeId || !manifestEntry.name || !manifestEntry.url) {
        throw new Error(`invalid entry ${index + 1} in manifest: ${filename}`);
      }
      rows.push({
        ...manifestEntry,
        id: `manifest:${filename}:${index}`,
        manifestFile: filename,
        listName: manifestEntry.listName || manifest.listName,
        sourceRow: manifestEntry.sourceRow ?? "",
        checkpointGoogleUrl: manifestEntry.googleUrl ?? "",
      });
    }
  }

  return { files, rows };
}
