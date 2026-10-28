# gmaps-multi-save

Playwright and CSV helpers for importing place lists into Google Maps saved lists.

## AGENTS.md

- This file and the `.agents/` directory should follow the progressive disclosure policy
- The top level AGENTS.md should ideally be < 50 lines, and never > 100
- The root AGENTS.md should contain only:
    - One-line project description
    - Package manager (if not npm)
    - Non-obvious commands only (skip `npm test`, `npm run build` if standard)
    - Links to `.agents/rules/` files with brief descriptions
    - Verification section (always required)
- Remaining instructions should go in `.agents/rules/` files by category (e.g., TypeScript conventions, testing patterns, API design, Git workflow).
- The following content should not go in AGENTS.md nor `.agents/` files:
    - **API documentation** — link to external docs instead
    - **Code examples** — agents can infer from reading source files
    - **Interface/type definitions** — these exist in the code
    - **Generic advice** — "write clean code", "follow best practices"
    - **Obvious instructions** — "use TypeScript for .ts files"
    - **Redundant info** — things already included in your operating instructions
    - **Too vague** — instructions that aren't actionable

## Commands

- `make` - Regenerate the README.
- `make readme.md` - Regenerate `readme.md` from `readme.tmpl.md`.
- `make data/michelin.csv` - Download the Michelin source CSV into `data/`.
- `make build/michelin-regional.csv` - Generate the regional Michelin import CSV.
- `npm run gmaps:migrate-manifests` - Migrate checkpoint history into local list manifests.
- `npm run audit:takeout` - Compare an expected CSV with Google Takeout lists.
- `npm run gmaps:save-list -- places.csv --note-only` - Repair notes only for places already saved in their lists.
- `make clean` - Remove generated artifacts.

## Rules

- [Project Workflow](.agents/rules/project-workflow.md) — source layout, generated-file policy, manual testing, and PR expectations.

## Verification

After making changes:

- `make` - Verify generated artifacts can be rebuilt.
- Run the changed converter script against a small CSV fixture when editing `*.mjs` converters.
