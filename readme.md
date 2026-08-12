<!-- DO NOT MODIFY THIS FILE DIRECTLY -->
<!-- instead modify readme.tmpl.md and run `make readme.md` -->

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
   javascript:function preamble(){return'\nconst btnSaveSelector=\'[data-value*="Save"]\';let logPrefix="";function log(...args){console.log(logPrefix,...args)}function logPrefixSet(prefix){logPrefix=prefix}function rest(val){return new Promise((resolve=>setTimeout((()=>resolve(val)),500)))}function goToUrl(url){_goToUrl_search(url)}function _goToUrl_search(url){const[latLon,name]=url.replace(//$/,"").split("/").reverse(),[lat,lon]=latLon.replace(/^@/,"").split(",");return search(`${lat},${lon}`),new Promise((resolve=>setTimeout((()=>{search(name),setTimeout((()=>resolve()),500)}),3e3)))}function search(searchText){const searchBox=document.querySelector("#searchboxinput"),searchButton=document.querySelector("#searchbox-searchbutton");if(!searchBox||!searchButton)throw"search box or search button not found";searchBox.value=searchText,searchButton.click()}function _goToUrl_direct(url){return log(`goToUrl ${url}`),new Promise((resolve=>fetch(url).then((res=>res.text())).then((data=>{document.open(),document.write(data),document.close()})).then((()=>resolve()))))}function observeUntilFound(_nodeObserve,nodesFindingSelectors){return log(`observeUntilFound ${nodesFindingSelectors}`),new Promise((resolve=>tryToFind(nodesFindingSelectors,resolve,Date.now())))}function tryToFind(nodesFindingSelectors,resolve,startTime){setTimeout((()=>{const nodesFinding=nodesFindingSelectors.map((selector=>document.querySelector(selector)));if(nodesFinding.every((node=>null!==node)))return void resolve(nodesFinding);const timeElapsedS=(Date.now()-startTime)/1e3;log(`🔎 ${nodesFindingSelectors}, ${timeElapsedS} s elapsed... `),tryToFind(nodesFindingSelectors,resolve,startTime)}),400)}function waitUntilClickable(btn){return log(`waitUntilClickable ${btn}`),new Promise((resolve=>checkClickable(btn,resolve,Date.now())))}function checkClickable(btn,resolve,startTime){setTimeout((()=>{if("function"==typeof btn.click)return void resolve(btn);const timeElapsedS=(Date.now()-startTime)/1e3;log(`🖱️❓ ${btn}, ${timeElapsedS} s elapsed...`),checkClickable(btn,resolve,startTime)}),200)}function addUrlToList(name,url,listName,note,loggingNote){return logPrefixSet(`[gmaps-add][${name}][${loggingNote}]`),goToUrl(url).then(rest).then((()=>observeUntilFound(document,[btnSaveSelector]))).then(rest).then((([btnSave])=>waitUntilClickable(btnSave))).then(rest).then((btnSave=>btnSave.click())).then(rest).then((()=>observeUntilFound(document.querySelector("#hovercard"),["#action-menu"]))).then((([menu])=>Array.from(menu.querySelectorAll("div")).find((div=>div.innerText===listName)))).then(rest).then((menuItemList=>{if("true"!==menuItemList.getAttribute("aria-checked"))return waitUntilClickable(menuItemList).then(rest).then((menuItemList=>menuItemList.click())).then(rest).then((()=>observeUntilFound(document.querySelector(\'[role="main"]\'),[`[aria-label="Add note in ${listName}"]`]))).then(rest).then((([btnAddNote])=>waitUntilClickable(btnAddNote))).then(rest).then((btnAddNote=>btnAddNote.click())).then(rest).then((()=>observeUntilFound(document.querySelector("#modal-dialog"),["#modal-dialog textarea"]))).then(rest).then((([textarea])=>{const btns=document.querySelectorAll("#modal-dialog button"),btnConfirm=Array.from(btns).find((btn=>"DONE"===btn.innerText));textarea.value=note,btnConfirm.click()})).then(rest);log(`already saved to ${listName}`)}))}'}function escapeSingleQuotes(str){return str.replace(/'/g,"\\'")}function genScript(data){const dataCount=data.length,addUrlToListsStr=data.map((({name:name,url:url,note:note,listName:listName},index)=>{const loggingNote=`[${index+1} / ${dataCount}]`;return`.then(() => addUrlToList("${name}", "${url}", "${listName}", '${escapeSingleQuotes(note)}', "${loggingNote}"))`})).join("\n");return`${preamble()}\n(() => Promise.resolve())()\n${addUrlToListsStr};`}function processCard(card){console.log(`card ${card}`);const nameEl=card.querySelector("h1");console.log(`nameEl ${nameEl}`);const name=nameEl.innerText;console.log(`name ${name}`);const descriptionEl=card.querySelector(".c-entry-content p");console.log(`descriptionEl ${descriptionEl}`);const description=descriptionEl.innerText;console.log(`description ${description}`);const servicesEls=Array.from(card.querySelectorAll(".services li a"));console.log(`servicesEls ${servicesEls}`);const gmapsEl=servicesEls.find((a=>"Open in Google Maps"===a.innerHTML));console.log(`gmapsEl ${gmapsEl}`);const gmapsRawLink=gmapsEl.href;console.log(`gmapsRawLink ${gmapsRawLink}`);const gmapsLink=gmapsRawLink.replace("https://google.com","").replace("https://www.google.com","");return console.log(`gmapsLink ${gmapsLink}`),{name:name,description:description,gmaps:gmapsLink}}function scrapeFromPage(){const eaterListTitleEl=document.querySelector(".c-mapstack__headline h1");console.log(`eaterListTitleEl ${eaterListTitleEl}`);const eaterListTitle=eaterListTitleEl.innerText;console.log(`eaterListTitle ${eaterListTitle}`);const updatedEl=document.querySelector('.c-mapstack__headline [data-ui="timestamp"]');console.log(`updatedEl ${updatedEl}`);const updated=updatedEl.innerText;console.log(`updated ${updated}`);const cardEls=Array.from(document.querySelectorAll("#content .c-mapstack__card"));console.log(`cardEls ${cardEls}`);const cards=cardEls.filter((card=>!["intro","newsletter","related-links","comments"].includes(card.getAttribute("data-slug"))));console.log(`cards ${cards}`);const cardData=cards.map(processCard);return console.log(`cardData ${cardData}`),[eaterListTitle,updated,cardData]}function noteForDatum(cardDatum,eaterListTitle,updated){return`Eater - ${eaterListTitle} (updated ${updated})\\n\\n${cardDatum.description}`}function cardDataToMapsData(cardData,eaterListTitle,updated,listName){cardData.length;return cardData.map((cardDatum=>{const note=noteForDatum(cardDatum,eaterListTitle,updated),urlRaw=cardDatum.gmaps,url=(()=>{if(urlRaw.includes("?api=1"))return urlRaw;const[latLong]=urlRaw.split("/").slice(-1);return`https://www.google.com/maps/search/${cardDatum.name}/@${latLong}`})();return{name:cardDatum.name,url:url,note:note,listName:listName}}))}function bookmarklet(){const listName=prompt("please enter the exact name of the google maps list (must already exist!)"),[eaterListTitle,updated,cardData]=scrapeFromPage(),script=genScript(cardDataToMapsData(cardData,eaterListTitle,updated,listName));navigator.clipboard.writeText(script),alert("script copied to clipboard!")}bookmarklet();   ```

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

This splits the 1-star and Bib Gourmand entries into regional lists. Mainland China has its own list. The East Asia lists contain Japan, Taiwan, Hong Kong, South Korea, and Macau; the other Asia lists contain the remaining Asia-Pacific, Middle East, and Oceania locations. The 2-star and 3-star lists remain global. Selected Restaurants entries are omitted. The regional list suffixes are `americas`, `france`, `western-europe`, `southern-europe`, `central-northern-eastern-europe`, `china`, `east-asia`, and `other-asia`.

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
