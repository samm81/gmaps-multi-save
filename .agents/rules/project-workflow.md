# Project Workflow

## Source Layout

The active Google Maps automation lives in `tools/`. Source-specific converters live at the repository root, including `michelin-to-csv.mjs` and `generic-to-csv.mjs`. The former bookmarklet workflow is preserved under `archive/bookmarklet/` and is not part of the active build.

Generated README output is checked in at the root as `readme.md`. Do not edit `readme.md` directly; update `readme.tmpl.md` and run `make readme.md`. Generated CSVs go under `build/`; temporary input data may go under `data/`.
Per-list Google Maps place manifests go under ignored `local/`.

## JavaScript Conventions

Follow the existing JavaScript style: two-space indentation, semicolons, double quotes unless single quotes reduce escaping, and small top-level functions. Name scripts by data flow or source, such as `source-to-csv.mjs` or `csv-to-target.mjs`.

## Testing

There is no automated test suite; `npm test` is a placeholder and exits with an error. For converter changes, run the relevant Node script against a small CSV fixture and inspect the output. For Google Maps automation or selector changes, rebuild with `make` and manually verify the affected runner workflow.

## Commits and Pull Requests

Git history uses short imperative messages, sometimes scoped by area, such as `readme: ...` or `Makefile: ...`. Pull requests should describe the workflow changed, list commands run, call out generated files updated, and attach screenshots or recordings for visible Google Maps behavior changes.

## Security

Do not commit personal Google Maps data, private CSV exports, API tokens, or browser cookies.
