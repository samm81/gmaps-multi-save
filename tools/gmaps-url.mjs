const gmapsSearchUrl = "https://www.google.com/maps/search";

export function makeGmapsSearchUrl(name, latitude, longitude) {
  return `${gmapsSearchUrl}/${encodeURIComponent(name)}/@${latitude},${longitude}`;
}
