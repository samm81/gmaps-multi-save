# ⚠️⚠️ BOOKMARKLET CURRENTLY BROKEN ⚠️⚠️

as of my most recent testing 2024-05-04 it seems that google has changed their `csp` to include a `script-src` with a `nonce` - meaning that the in-page navigation (done with `document.write(fetch(new_url))`) now fails (since the newly fetched scripts are not a part of the `nonce`) ☹️ which makes the bookmarklet/console approach dead in the water

the preferred path is now the Playwright runner, which drives a normal headed browser with a local persistent profile.

# gmaps-multi-save

google maps saved lists are great. before I travel anywhere I fill up my lists with possible places to eat, drink, shop, and tour. I populate from sites like eater, michelin guide, timeout, and lonely planet.

populating these lists used to be a terribly manual ordeal. not anymore 😎

# playwright saved-list import

this path avoids in-page script injection and uses the same csv shape as the old paste-snippet workflow: `name,url,note,listName`.

first, create the dedicated local browser profile and sign in manually. the login command opens the installed browser directly because google may reject automated sign-in:

```bash
npm run gmaps:login
```

close that browser after signing in, then press enter in the terminal. the profile lives under `.playwright/google-profile` and is ignored by git.

then generate a csv using one of the source converters and run:

```bash
npm run gmaps:save-list -- places.csv --limit 20 --delay-ms 2500
```

the runner stores the browser profile and checkpoints under `.playwright/`, which is ignored by git. keep google maps open in the launched browser, stop if google shows an account challenge, and rerun the same command to resume after already-completed rows.

# sources

## eater

### setup

1. create a new bookmark
1. copy/paste the following code into the URL field

   ```javascript
   javascript: alert("eater-gmaps bookmarklet placeholder");
   ```

1. save the bookmark

https://github.com/samm81/gmaps-multi-save/assets/1221372/4176953e-256a-4dc8-aa52-33bee90093ae

### usage

1. open up google maps
1. from the sidebar, go to "Saved" -> "Lists"
1. either "+ New list" or find the name of a list you already have that you want to use (like "Want to go")
1. navigate to an eater list (for example, [the 38 best restaurants in new york city](https://ny.eater.com/maps/best-new-york-restaurants-38-map))
1. click the bookmarklet you created in [setup]
1. enter the name of the google maps list you picked
1. a popup should appear saying "script copied to clipboard!"
1. go back to google maps
1. open up the console (ctrl+shift+i usually)
1. paste into console
1. hit enter and watch it run!

https://github.com/samm81/gmaps-multi-save/assets/1221372/8ce649e8-b218-448b-aeef-77f05ff8d563

## michelin

### usage

1. clone the repo
1. `make`
1. `make data/michelin.csv`
1. `node michelin-to-csv.mjs -i './data/michelin.csv' --loc "${LOCATION}" -o "michelin-${LOCATION}.csv"`
1. ensure you have four lists in google maps
   1. michelin-😋
   1. michelin-⭐
   1. michelin-⭐⭐
   1. michelin-⭐⭐⭐
1. `npm run gmaps:login`
1. `npm run gmaps:save-list -- "michelin-${LOCATION}.csv" --limit 20`

### regional lists

To generate smaller global lists, run:

```bash
make build/michelin-regional.csv
```

This splits the 1-star and Bib Gourmand entries into regional lists. The 2-star and 3-star lists remain global. Selected Restaurants entries are omitted. The regional list suffixes are `americas`, `france`, `western-europe`, `southern-europe`, `central-northern-eastern-europe`, `china-japan`, and `other-asia-pacific-middle-east-oceania`.

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

### reverse import

I often find it useful to reverse the order of the generated michelin list, as it goes from highest rated (⭐⭐⭐) to lowest (😋), but I'd rather import the bib-gourmand entries first. here's an example of how to do that:

```bash
node csv-to-gmaps-paste-snippet.mjs <(cat <(head -n 1 taipei-michelin.csv) <(tail -n +2 taipei-michelin.csv | tac)) > taipei-michelin.js
```

## generic

if you have another data source, you can create a csv file with just two columns, `name` and `note`. then run the `generic-to-csv` script, providing a set of coordinates around which to center the text searches, and the name of the list to add to. for example, if you've got a file with a list of unesco heritage sites for kyoto, and you know kyoto's coordinates are `35.0081133,135.7615855`, then you'd run:

```bash
node generic-to-csv.mjs \
    -i ./data/unesco-kyoto.csv \
    -o kyoto-unesco.csv \
    --coords '35.0081133,135.7615855' \
    --listname 'unseco'
```

# appendix

### notes

- 🐞 high likelihood of bugs
  - 🧑‍💻 the Playwright runner still relies on google maps UI labels/selectors, so it can break when google changes saved-list controls
  - 📜 use small batches with `--limit` and rerun after failures; completed rows are tracked in `.playwright/gmaps-save-checkpoint.json`

🙏 please submit bugs to github repo

### roadmap

1. add other sources
   1. michelin guide
   1. timeout
   1. lonely planet
   1. atlas obscura
   1. suggest one!
1. since we're already using `terser` we could use a proper build system and refactor to modules 🤷
1. we could also switch to typescript 🤷
1. (very ambitious) identify when stuck, or when css selector has changed, and allow user to hotfix it during execution (by clicking on an item ?)
