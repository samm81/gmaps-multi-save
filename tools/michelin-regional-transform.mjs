import { readFile, writeFile } from "node:fs/promises";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";
import getopts from "getopts";

const options = getopts(process.argv.slice(2), {
  alias: {
    infile: ["i", "in", "infile"],
    outfile: ["o", "out", "outfile"],
    excludeChina: ["exclude-china"],
    reverse: ["reverse"],
  },
});

if (!options.infile) throw new Error("must provide `--infile`");
if (!options.outfile) throw new Error("must provide `--outfile`");

let rows = parse(await readFile(options.infile), {
  bom: true,
  columns: true,
});

if (options.excludeChina) {
  rows = rows.filter(({ location }) => {
    return !String(location).trim().endsWith("Chinese Mainland");
  });
}

if (options.reverse) rows.reverse();

await writeFile(options.outfile, stringify(rows, { header: true }));
