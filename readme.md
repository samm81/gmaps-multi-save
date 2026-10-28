<!-- DO NOT MODIFY THIS FILE DIRECTLY -->
<!-- instead modify readme.tmpl.md and run `make readme.md` -->

# gmaps-multi-save

Tools for importing place lists into Google Maps saved lists.

The active workflow uses a normal headed browser controlled by Playwright. The former browser-console and bookmarklet workflow is preserved under [`archive/bookmarklet/`](archive/bookmarklet/).

## Playwright saved-list import

This workflow uses CSV files with the columns `name,url,note,listName` and optional source metadata: `michelinUrl`, `address`, `location`, `latitude`, and `longitude`.

First, create the dedicated local browser profile and sign in manually. The login command opens the installed browser directly because Google may reject automated sign-in:

```bash
npm run gmaps:login
```

Close that browser after signing in, then press Enter in the terminal. The profile lives under `.playwright/google-profile` and is ignored by Git.

Then generate a CSV using one of the source converters and run:

```bash
npm run gmaps:save-list -- places.csv --limit 20 --delay-ms 1000
```

The runner stores the browser profile and checkpoints under `.playwright/`, which is ignored by Git. Successful saves also update one place manifest per Google Maps list under `local/`, which is ignored by Git. Keep Google Maps open in the launched browser, stop if Google shows an account challenge, and rerun the same command to resume after already-completed rows.

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

The generated Michelin rows retain the Michelin page URL, source address, and coordinates. The runner searches for the Michelin name with its address, then the name alone. If neither resolves, it searches for restaurants at the source address within 100 meters. As a final fallback, it uses the query from Michelin's embedded Google map, which may contain a local-language address instead of coordinates. For differently named results, the street address must also match; when multiple places are nearby, the runner chooses one only if it is clearly nearest. Otherwise, it records a failure for manual review. The runner verifies the place again after opening Save and before selecting the list. Normal name searches use the default 1000-meter limit; change it with `--max-distance-m 50` (or another positive distance). For a Michelin row whose `url` is a direct Google Maps place URL, the place ID is authoritative even if Michelin's coordinates differ. Successful checkpoints and per-list manifests retain that verified place ID.

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

The checkpoint records completed rows and an attempt history with timestamps, source metadata, resolved Google URLs, errors, and failure screenshots under `output/playwright/`. Successful saves also update one manifest per Google Maps list under `local/`; the manifest records the stable Google place ID needed for later audits. By default, rerunning skips both completed rows and rows already present in the attempt history, including failures. Add `--retry-failed` to retry previous failures. Use `--dry-run` to inspect counts first, or omit `--continue-on-error` to stop after recording the first failure.

To bootstrap manifests from older checkpoints, run the migration once and repeat the option for each checkpoint that contains import history:

```bash
npm run gmaps:migrate-manifests -- \
    --checkpoint '.playwright/michelin-⭐⭐.json' \
    --checkpoint '.playwright/michelin-😋-americas.json'
```

The migration writes ignored per-list manifests under `local/`; future saves maintain them automatically. Add `--include-partial-saves` to recover historical attempts that failed while waiting for a note field after Google Maps had already returned a verified place URL. Use repeated `--exclude-list-name` options when replaying checkpoints that contain retired lists.

If the Playwright page, context, or browser closes while handling a failure, the runner records the failure safely and attempts to reopen Google Maps with the same profile before continuing. Use `--continue-on-error` if later rows should continue after that failed row.

A failed attempt can be left half done: Google Maps may add the place to the list before the note field appears or the note is saved. When rerunning errors, an already-saved place may therefore still need its text note added; the runner checks the list state and retries note entry. The runner waits up to 60 seconds for the note field by default; change this with `--note-timeout-ms 120000`.

To repair notes without changing list membership or manifests, run `gmaps:save-list` with `--note-only`. The CSV still needs `name`, `url`, `note`, and `listName`; use an exact Google Maps place URL or add a `placeId` column when searching by name. The runner refuses places not already saved in the target list.

To remove a stale place from a list, use a CSV containing the exact old Google Maps place URL and list name, then run the same checkpointed workflow with `--remove`. The runner only unchecks a list item when Google reports it is currently checked:

```bash
npm run gmaps:save-list -- 'stale-places.csv' \
    --remove \
    --checkpoint '.playwright/remove-stale-places.json' \
    --continue-on-error
```

The removal checkpoint is separate from the save checkpoint, so both operations can be audited and resumed independently.

### audit a Takeout export

To compare a Google Takeout saved-list export with an expected source CSV, run:

```bash
npm run audit:takeout -- \
    --source expected.csv \
    --takeout-dir Takeout \
    --output takeout-audit.csv \
    --report takeout-audit.json
```

The source CSV must contain `name`, `url`, and `listName` columns. The audit maps each Takeout filename to the matching source list, including list names truncated to Google’s 40-character limit, and ignores files that do not resolve to a source list. When no `--baseline-source` is provided, the audit loads the per-list manifests from `local/` automatically; this makes a normal Takeout audit independent of the runner checkpoints. Override that directory with `--manifest-dir`. Membership matching is one-to-one within each list: unique place IDs, saved notes, and normalized names are tried in that order, while duplicate values remain unresolved. A unique same-list name variant that passes the close-enough check is accepted as a match. Unique cross-list matches are reported as `wrong-list`; name variants with multiple candidates are reported as `ambiguous-name`. If membership matches but both descriptions are present and differ, the output reports one `description-changed` row. The output CSV contains one row for every missing membership, extra membership, description change, or wrong-list relation. Wrong-list rows include both the expected source list and the actual Takeout list, so one misplaced restaurant is reported once. Pass `--notes-output notes.csv` to produce a separate audit of source notes that are missing or different in Takeout. Keep exports and audit output outside tracked source directories; personal Takeout data is ignored by Git.

For a historical import audit, pass the exact source snapshot used for that import as `--baseline-source`, then repeat `--checkpoint checkpoint.json` for the save checkpoints that contain successful attempts. The baseline is used for membership, and successful checkpoint URLs provide stable Google place IDs so renamed Google Maps titles do not create false missing/extra rows. The current `--source` is compared with the baseline separately; source rows with the same unique normalized name and description are treated as the same restaurant even when their address or coordinates changed. Pass `--changes-output source-changes.csv` to write rows that were added, removed, renamed, moved between lists, or had source metadata updated. New runner checkpoints store a hashed copy of their input CSV beside the checkpoint and refuse to resume against a changed CSV. Older checkpoints do not contain this snapshot, so provide their historical source explicitly. This historical mode is the only mode that needs checkpoint files; the ordinary current-source audit uses `local/` manifests instead.

### Michelin manual review

Known Michelin entries that require manual review are recorded in [`michelin/manual-review.csv`](michelin/manual-review.csv). These rows remain in the canonical build so the source total stays complete.

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
- Use small batches with `--limit` and rerun after failures; resume history is tracked in `.playwright/gmaps-save-checkpoint.json` and successful place identities are tracked in the ignored per-list manifests under `local/`.
