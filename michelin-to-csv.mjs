import { createReadStream, createWriteStream } from "node:fs";
import { parse } from "csv-parse";
import { stringify } from "csv-stringify";
import { transform } from "stream-transform";
import getopts from "getopts";

const gmapsSearchUrl = "https://www.google.com/maps/search";

function makeGmapsSearchUrl(name, lat, lon) {
  return `${gmapsSearchUrl}/${name}/@${lat},${lon}`;
}

function awardToEmoji(award) {
  switch (award) {
    case "1 Star":
      return "⭐";
    case "2 Stars":
      return "⭐⭐";
    case "3 Stars":
      return "⭐⭐⭐";
    case "Bib Gourmand":
      return "😋";
    default:
      throw new Error(`unknown award ${award}`);
  }
}

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

function main() {
  const options = getopts(process.argv.slice(2), {
    alias: {
      infile: ["i", "in", "infile"],
      outfile: ["o", "out", "outfile"],
      location: ["l", "loc", "location"],
    },
  });
  if (!options.infile) throw new Error("must provide `--infile`");
  if (!options.outfile) throw new Error("must provide `--outfile`");

  const outFileStream = createWriteStream(options.outfile);
  createReadStream(options.infile)
    .pipe(parse({ bom: true, columns: true }))
    .pipe(
      transform((record) => {
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
        }) => ({
          name,
          lon,
          lat,
          award,
          note,
        })
      )
    )
    .pipe(
      transform(({ name, lon, lat, award, note }) => ({
        name,
        url: makeGmapsSearchUrl(name, lat, lon),
        note: `${awardToEmoji(award)}\\n\\n${note}`,
        listName: awardToListName(award),
      }))
    )
    .pipe(stringify({ header: true }))
    .pipe(outFileStream);
}

main();
