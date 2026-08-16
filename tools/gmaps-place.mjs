import { normalizeMapsUrl } from "./gmaps-playwright.mjs";

export const maxDistanceMDefault = 100;

export function sourceCoordinates(row) {
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

export function hasSourceLocation(row) {
  return Boolean(sourceCoordinates(row) || row.address?.trim());
}

export function validCoordinates(latitude, longitude) {
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  );
}

export function distanceInMeters(first, second) {
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
  return (
    2 * earthRadiusM * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine))
  );
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

export function addressesMatch(sourceAddress, placeAddress) {
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

export function appendAddressSearchTerm(url, address) {
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

export function searchAttemptsForRow(row) {
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

export function placeReferenceFromUrl(url) {
  if (!url) return null;

  const placeId = placeIdFromUrl(url);
  const coordinates = placeCoordinatesFromUrl(url);
  const path = placePathFromUrl(url);
  if (!placeId && !coordinates && !path) return null;

  return { placeId, coordinates, path };
}

export function placesMatch(first, second, maxDistanceM = maxDistanceMDefault) {
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

export function placeNamesMatch(expectedName, actualName) {
  const expected = normalizedPlaceName(expectedName?.split(",", 1)[0]);
  const actual = normalizedPlaceName(actualName);
  if (!expected || !actual) return false;
  return (
    expected === actual ||
    expected.includes(actual) ||
    actual.includes(expected)
  );
}

export function absoluteMapsUrl(url) {
  if (!url) return null;
  try {
    return new URL(url, "https://www.google.com").toString();
  } catch {
    return url;
  }
}
