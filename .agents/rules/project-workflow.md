# Project Workflow

## Source Layout

Core Google Maps automation lives in `gmaps-add.js`. Source-specific scrapers and converters live at the repository root, including `from-eater.js`, `michelin-to-csv.mjs`, `generic-to-csv.mjs`, and `make-gmaps-paste-snippet.js`.

Generated output is also checked in at the root: `bookmarklet-eater.js`, `csv-to-gmaps-paste-snippet.mjs`, and `readme.md`. Do not edit `readme.md` directly; update `readme.tmpl.md` and run `make readme.md`. Demo media lives in `assets/`. Temporary input data may go under `data/`.

## JavaScript Conventions

Follow the existing JavaScript style: two-space indentation, semicolons, double quotes unless single quotes reduce escaping, and small top-level functions. Name scripts by data flow or source, such as `source-to-csv.mjs` or `csv-to-target.mjs`.

## Testing

There is no automated test suite; `npm test` is a placeholder and exits with an error. For converter changes, run the relevant Node script against a small CSV fixture and inspect the output. For Google Maps automation or selector changes, rebuild with `make`, paste the generated snippet into Google Maps, and verify list selection, duplicate skipping, and note entry.

## Commits and Pull Requests

Git history uses short imperative messages, sometimes scoped by area, such as `readme: ...` or `Makefile: ...`. Pull requests should describe the workflow changed, list commands run, call out generated files updated, and attach screenshots or recordings for visible Google Maps behavior changes.

## Security

Do not commit personal Google Maps data, private CSV exports, API tokens, or browser cookies. The bookmarklet runs in the active page context, so review generated snippets before sharing them.
