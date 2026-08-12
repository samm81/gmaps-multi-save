<!-- DO NOT MODIFY THIS FILE DIRECTLY -->
<!-- instead modify readme.tmpl.md and run `make readme.md` -->

# gmaps-multi-save

Tools for importing place lists into Google Maps saved lists.

The active workflow uses a normal headed browser controlled by Playwright. The former browser-console and bookmarklet workflow is preserved under [`archive/bookmarklet/`](archive/bookmarklet/).

## Playwright saved-list import

This workflow uses CSV files with the columns `name,url,note,listName` and optional source metadata: `address`, `location`, `latitude`, and `longitude`.

First, create the dedicated local browser profile and sign in manually. The login command opens the installed browser directly because Google may reject automated sign-in:

```bash
npm run gmaps:login
```

Close that browser after signing in, then press Enter in the terminal. The profile lives under `.playwright/google-profile` and is ignored by Git.

Then generate a CSV using one of the source converters and run:

```bash
npm run gmaps:save-list -- places.csv --limit 20 --delay-ms 2500
```

The runner stores the browser profile and checkpoints under `.playwright/`, which is ignored by Git. Keep Google Maps open in the launched browser, stop if Google shows an account challenge, and rerun the same command to resume after already-completed rows.

## sources

### michelin

To download the current Michelin source data:

```bash
make data/michelin.csv
```

For a single location, generate a four-list CSV:

```bash
node michelin-to-csv.mjs \
    -i data/michelin.csv \
    --loc "${LOCATION}" \
    -o "michelin-${LOCATION}.csv"
```

The four global list names are `michelin-😋`, `michelin-⭐`, `michelin-⭐⭐`, and `michelin-⭐⭐⭐`.

### regional lists

To generate smaller global lists, run:

```bash
make build/michelin-regional.csv
```

This splits the 1-star and Bib Gourmand entries into regional lists. Mainland China has its own list. The East Asia lists contain Japan, Taiwan, Hong Kong, South Korea, and Macau; the other Asia lists contain the remaining Asia-Pacific, Middle East, and Oceania locations. The 2-star and 3-star lists remain global. Selected Restaurants entries are omitted. The regional list suffixes are `americas`, `france`, `western-europe`, `southern-europe`, `central-northern-eastern-europe`, `china`, `east-asia`, and `other-asia-pacific-middle-east-oceania`. The long final suffix is retained for import checkpoint compatibility; Google Maps lookups use its first 40 characters.

To reverse the full regional file, run `make build/michelin-regional-reversed.csv`.

To omit Mainland China, generate `build/michelin-regional--no-china.csv`. To process that file from the end first, generate `build/michelin-regional--no-china--reversed.csv`; its Bib Gourmand rows come first.

The generated Michelin rows retain the source address and coordinates. Before saving a row, the Playwright runner checks that Google Maps resolved a place within 1,000 meters of the Michelin coordinates. When Google keeps the browser on a search URL, it checks the visible place address instead. If the initial search cannot find a place or fails location verification, it retries once with the Michelin address appended to the search term. Rows that do not pass either check are recorded as failures and are not saved. Adjust the coordinate tolerance with `--max-distance-m 500` (or another positive distance in meters).

After creating those lists in Google Maps, run:

```bash
npm run gmaps:save-list -- 'build/michelin-regional.csv'
```

To import only one list, filter by its exact `listName` without changing the generated CSV:

```bash
npm run gmaps:save-list -- 'build/michelin-regional.csv' \
    --list-name 'michelin-😋-france' \
    --checkpoint '.playwright/michelin-bib-france.json' \
    --continue-on-error
```

The checkpoint records completed rows and an attempt history with timestamps, source metadata, resolved Google URLs, errors, and failure screenshots under `output/playwright/`. By default, rerunning skips both completed rows and rows already present in the attempt history, including failures. Add `--retry-failed` to retry previous failures. Use `--dry-run` to inspect counts first, or omit `--continue-on-error` to stop after recording the first failure.

A failed attempt can be left half done: Google Maps may add the place to the list before the note field appears or the note is saved. When rerunning errors, an already-saved place may therefore still need its text note added; the runner checks the list state and retries note entry. The runner waits up to 60 seconds for the note field by default; change this with `--note-timeout-ms 120000`.

### migration reminder

The current manual Michelin list migration is documented in [`michelin-regional-migration.md`](michelin-regional-migration.md).

### generic

If you have another data source, create a CSV file with two columns, `name` and `note`. Then run `generic-to-csv`, providing coordinates around which to center the text searches and the name of the list to add to. For example:

```bash
node generic-to-csv.mjs \
    -i ./data/unesco-kyoto.csv \
    -o kyoto-unesco.csv \
    --coords '35.0081133,135.7615855' \
    --listname 'unesco'
```

## notes

- The Playwright runner relies on Google Maps UI labels and selectors, so it can break when Google changes saved-list controls.
- Use small batches with `--limit` and rerun after failures; completed rows are tracked in `.playwright/gmaps-save-checkpoint.json`.
