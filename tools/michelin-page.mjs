import { runnerError, errorCodes } from "./gmaps-errors.mjs";
import { sleep } from "./gmaps-playwright.mjs";
import { validCoordinates } from "./gmaps-place.mjs";

const michelinMapFrameSelector = 'iframe[src*="google.com/maps/embed"]';
const michelinMapFrameTimeoutMs = 30000;
const michelinOrigin = "https://guide.michelin.com";

async function clearMichelinSiteData(page) {
  const client = await page.context().newCDPSession(page);
  try {
    await client.send("Storage.clearDataForOrigin", {
      origin: michelinOrigin,
      storageTypes: "all",
    });
  } finally {
    await client.detach().catch(() => {});
  }

  await page.context().clearCookies({ domain: "guide.michelin.com" });
}

function coordinatePair(value) {
  const match = String(value ?? "").match(
    /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/
  );
  if (!match) return null;

  const latitude = Number(match[1]);
  const longitude = Number(match[2]);
  return validCoordinates(latitude, longitude)
    ? { latitude, longitude }
    : null;
}

export function michelinMapCoordinatesFromUrl(url) {
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    return null;
  }

  for (const parameter of ["q", "query", "center", "ll"]) {
    const coordinates = coordinatePair(parsedUrl.searchParams.get(parameter));
    if (coordinates) return coordinates;
  }

  return null;
}

async function waitForMichelinMapFrame(page) {
  const frame = page.locator(michelinMapFrameSelector).first();
  const deadline = Date.now() + michelinMapFrameTimeoutMs;

  while (Date.now() < deadline) {
    if ((await frame.count().catch(() => 0)) > 0) {
      const source = await frame.getAttribute("src").catch(() => null);
      if (source) return { frame, source };
    }
    await sleep(250);
  }

  throw runnerError(
    errorCodes.locationUnverified,
    "Michelin page did not expose a Google Maps location iframe"
  );
}

export async function findMichelinMapCoordinates(page, michelinUrl) {
  await clearMichelinSiteData(page);

  try {
    await page.goto(michelinUrl, {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });
  } catch (error) {
    throw runnerError(
      errorCodes.navigationUnavailable,
      `could not navigate to Michelin page: ${error.message}`
    );
  }

  const { source } = await waitForMichelinMapFrame(page);
  const coordinates = michelinMapCoordinatesFromUrl(source);
  if (!coordinates) {
    throw runnerError(
      errorCodes.locationUnverified,
      "Michelin page exposed a Google Maps iframe without coordinates"
    );
  }

  return { coordinates };
}
