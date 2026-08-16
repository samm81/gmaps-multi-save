import { createReadStream, createWriteStream } from "node:fs";
import { parse } from "csv-parse";
import { stringify } from "csv-stringify";
import { transform } from "stream-transform";
import getopts from "getopts";
import { makeGmapsSearchUrl } from "./tools/gmaps-url.mjs";
const supportedAwards = new Set([
  "1 Star",
  "2 Stars",
  "3 Stars",
  "Bib Gourmand",
]);
const regionalAwards = new Set(["1 Star", "Bib Gourmand"]);

const regionByCountry = new Map();

function addRegion(region, countries) {
  countries.forEach((country) => regionByCountry.set(country, region));
}

addRegion("americas", ["USA", "Canada", "Mexico", "Argentina", "Brazil"]);
addRegion("france", ["France"]);
addRegion("western-europe", [
  "United Kingdom",
  "Belgium",
  "Netherlands",
  "Ireland",
  "Principality of Monaco",
]);
addRegion("southern-europe", [
  "Italy",
  "Spain",
  "Portugal",
  "Greece",
  "Malta",
  "Andorra",
]);
addRegion("central-northern-eastern-europe", [
  "Germany",
  "Switzerland",
  "Austria",
  "Denmark",
  "Poland",
  "Sweden",
  "Croatia",
  "Czechia",
  "Hungary",
  "Norway",
  "Slovenia",
  "Luxembourg",
  "Lithuania",
  "Estonia",
  "Finland",
  "Latvia",
  "Serbia",
  "Iceland",
  "Liechtenstein",
]);
addRegion("china", ["Chinese Mainland"]);
addRegion("east-asia", [
  "Japan",
  "Taiwan",
  "Hong Kong SAR China",
  "South Korea",
  "Macau",
]);
addRegion("other-asia-pacific-middle-east-oceania", [
  "Thailand",
  "THA",
  "Singapore",
  "Vietnam",
  "Malaysia",
  "The Philippines",
  "Türkiye",
  "Dubai",
  "Abu Dhabi",
  "ARE",
  "Qatar",
  "Saudi Arabia",
  "New Zealand",
]);

function awardToListName(award) {
  switch (award) {
    case "1 Star":
      return "michelin-⭐";
    case "2 Stars":
      return "michelin-⭐⭐";
    case "3 Stars":
      return "michelin-⭐⭐⭐";
    case "Bib Gourmand":
      return "michelin-😋";
    default:
      throw new Error(`unknown award ${award}`);
  }
}

function locationToRegion(location) {
  const locationSuffix = location.split(", ").pop();
  const region = regionByCountry.get(locationSuffix);
  if (!region) throw new Error(`unknown region for location ${location}`);
  return region;
}

function awardToRegionalListName(award, location, splitRegions) {
  const listName = awardToListName(award);
  if (!splitRegions || !regionalAwards.has(award)) return listName;
  return `${listName}-${locationToRegion(location)}`;
}

function main() {
  const options = getopts(process.argv.slice(2), {
    alias: {
      infile: ["i", "in", "infile"],
      outfile: ["o", "out", "outfile"],
      location: ["l", "loc", "location"],
      splitRegions: ["split-regions", "regions"],
    },
  });
  if (!options.infile) throw new Error("must provide `--infile`");
  if (!options.outfile) throw new Error("must provide `--outfile`");

  const outFileStream = createWriteStream(options.outfile);
  createReadStream(options.infile)
    .pipe(parse({ bom: true, columns: true }))
    .pipe(
      transform((record) => {
        if (!supportedAwards.has(record.Award)) return null;
        const { Location: location } = record;
        if (options.location && location !== options.location) return null;
        return record;
      })
    )
    .pipe(
      transform(
        ({
          Name: name,
          Longitude: lon,
          Latitude: lat,
          Award: award,
          Description: note,
          Address: address,
          Location: location,
        }) => ({
          name,
          lon,
          lat,
          award,
          note,
          address,
          location,
        })
      )
    )
    .pipe(
      transform(({ name, lon, lat, award, note, address, location }) => ({
        name,
        url: makeGmapsSearchUrl(name, lat, lon),
        note,
        listName: awardToRegionalListName(award, location, options.splitRegions),
        address,
        location,
        latitude: lat,
        longitude: lon,
      }))
    )
    .pipe(stringify({ header: true }))
    .pipe(outFileStream);
}

main();
