import { createReadStream, createWriteStream } from "node:fs";
import { parse } from "csv-parse";
import { stringify } from "csv-stringify";
import { transform } from "stream-transform";
import getopts from "getopts";

const gmapsSearchUrl = "https://www.google.com/maps/search";

function makeGmapsSearchUrl(name, coords) {
  return `${gmapsSearchUrl}/${name}/@${coords}`;
}

function main() {
  const options = getopts(process.argv.slice(2), {
    alias: {
      infile: ["i", "in", "infile"],
      outfile: ["o", "out", "outfile"],
      coords: ["c", "coords"],
      listname: ["l", "ln", "listname"],
    },
  });
  if (!options.infile) throw new Error("must provide `--infile`");
  if (!options.outfile) throw new Error("must provide `--outfile`");
  if (!options.coords) throw new Error("must provide `--coords`");
  if (!options.listname) throw new Error("must provide `--listname`");

  const outFileStream = createWriteStream(options.outfile);
  createReadStream(options.infile)
    .pipe(parse({ bom: true, columns: true }))
    .pipe(
      transform(({ name, note }) => {
        if (!name) throw new Error("a record is missing `name`");
        return {
          name,
          url: makeGmapsSearchUrl(name, options.coords),
          note: note ?? "",
          listName: options.listname,
        };
      })
    )
    .pipe(stringify({ header: true }))
    .pipe(outFileStream);
}

main();
