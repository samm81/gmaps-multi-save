export const errorCodes = Object.freeze({
  placeUnresolved: "PLACE_UNRESOLVED",
  placeAmbiguous: "PLACE_AMBIGUOUS",
  placeUnverified: "PLACE_UNVERIFIED",
  locationUnverified: "LOCATION_UNVERIFIED",
  navigationUnavailable: "NAVIGATION_UNAVAILABLE",
  saveUnavailable: "SAVE_UNAVAILABLE",
  listUnavailable: "LIST_UNAVAILABLE",
  noteUnavailable: "NOTE_UNAVAILABLE",
});

export function runnerError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

export function unresolvedPlaceError(name, cause, details = {}) {
  return runnerError(
    errorCodes.placeUnresolved,
    `could not resolve ${name} to a Google Maps place result: ${cause.message}`,
    details
  );
}
