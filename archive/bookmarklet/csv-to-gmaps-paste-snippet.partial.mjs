// `make-gmaps-paste-snippet` concated which contains `genScript`

import { readFile } from "node:fs/promises";
import { parse } from "csv-parse/sync";
import getopts from "getopts";

const gmapsSearchUrl = "https://www.google.com/maps/search";

async function main() {
  const options = getopts(process.argv.slice(2), {});
  const csvFileName = (options._ ?? [])[0];
  if (!csvFileName) throw new Error("must supply csv as first argument");

  const csvRaw = await readFile(csvFileName);
  const data = parse(csvRaw, {
    bom: true,
    columns: true,
    trim: true,
  });

  data.forEach(({ name, url, note, listName }) => {
    if (
      name === undefined ||
      url === undefined ||
      note === undefined ||
      listName === undefined
    )
      throw new Error("undefined data");
  });

  return genScript(data);
}

console.log(await main());
