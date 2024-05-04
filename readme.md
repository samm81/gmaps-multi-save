<!-- DO NOT MODIFY THIS FILE DIRECTLY -->
<!-- instead modify readme.tmpl.md and run `make readme.md` -->

# ⚠️⚠️ CURRENTLY BROKEN ⚠️⚠️

as of my most recent testing 2024-05-04 it seems that google has changed their `csp` to include a `script-src` with a `nonce` - meaning that the in-page navigation (done with `document.write(fetch(new_url))`) now fails (since the newly fetched scripts are not a part of the `nonce`) ☹️ which makes this approach dead in the water

other options possibly include more traditional browser automation techniques (headless) or reverse engineering the saved lists api.

# gmaps-multi-save

google maps saved lists are great. before I travel anywhere I fill up my lists with possible places to eat, drink, shop, and tour. I populate from sites like eater, michelin guide, timeout, and lonely planet.

populating these lists used to be a terribly manual ordeal. not anymore 😎

# sources

## eater

### setup

1. create a new bookmark
1. copy/paste the following code into the URL field

   ````javascript
   javascript:function preamble(){return'\nconst btnSaveSelector=\'[data-value*="Save"]\';let logPrefix="";function log(...args){console.log(logPrefix,...args)}function logPrefixSet(prefix){logPrefix=prefix}function rest(val){return new Promise((resolve=>setTimeout((()=>resolve(val)),500)))}function goToUrl(url){return log(`goToUrl ${url}`),new Promise((resolve=>fetch(url).then((res=>res.text())).then((data=>{document.open(),document.write(data),document.close()})).then((()=>resolve()))))}function observeUntilFound(_nodeObserve,nodesFindingSelectors){return log(`observeUntilFound ${nodesFindingSelectors}`),new Promise((resolve=>tryToFind(nodesFindingSelectors,resolve,Date.now())))}function tryToFind(nodesFindingSelectors,resolve,startTime){setTimeout((()=>{const nodesFinding=nodesFindingSelectors.map((selector=>document.querySelector(selector)));if(nodesFinding.every((node=>null!==node)))return void resolve(nodesFinding);const timeElapsedS=(Date.now()-startTime)/1e3;log(`🔎 ${nodesFindingSelectors}, ${timeElapsedS} s elapsed... `),tryToFind(nodesFindingSelectors,resolve,startTime)}),400)}function waitUntilClickable(btn){return log(`waitUntilClickable ${btn}`),new Promise((resolve=>checkClickable(btn,resolve,Date.now())))}function checkClickable(btn,resolve,startTime){setTimeout((()=>{if("function"==typeof btn.click)return void resolve(btn);const timeElapsedS=(Date.now()-startTime)/1e3;log(`🖱️❓ ${btn}, ${timeElapsedS} s elapsed...`),checkClickable(btn,resolve,startTime)}),200)}function addUrlToList(name,url,listName,note,loggingNote){return logPrefixSet(`[gmaps-add][${name}][${loggingNote}]`),goToUrl(url).then(rest).then((()=>observeUntilFound(document,[btnSaveSelector]))).then(rest).then((([btnSave])=>waitUntilClickable(btnSave))).then(rest).then((btnSave=>btnSave.click())).then(rest).then((()=>observeUntilFound(document.querySelector("#hovercard"),["#action-menu"]))).then((([menu])=>Array.from(menu.querySelectorAll("div")).find((div=>div.innerText===listName)))).then(rest).then((menuItemList=>{if("true"!==menuItemList.getAttribute("aria-checked"))return waitUntilClickable(menuItemList).then(rest).then((menuItemList=>menuItemList.click())).then(rest).then((()=>observeUntilFound(document.querySelector(\'[role="main"]\'),[`[aria-label="Add note in ${listName}"]`]))).then(rest).then((([btnAddNote])=>waitUntilClickable(btnAddNote))).then(rest).then((btnAddNote=>btnAddNote.click())).then(rest).then((()=>observeUntilFound(document.querySelector("#modal-dialog"),["#modal-dialog textarea"]))).then(rest).then((([textarea])=>{const btns=document.querySelectorAll("#modal-dialog button"),btnConfirm=Array.from(btns).find((btn=>"DONE"===btn.innerText));textarea.value=note,btnConfirm.click()})).then(rest);log(`already saved to ${listName}`)}))}'}function escapeSingleQuotes(str){return str.replace(/'/g,"\\'")}function genScript(data){const dataCount=data.length,addUrlToListsStr=data.map((({name:name,url:url,note:note,listName:listName},index)=>{const loggingNote=`[${index+1} / ${dataCount}]`;return`.then(() => addUrlToList("${name}", "${url}", "${listName}", '${escapeSingleQuotes(note)}', "${loggingNote}"))`})).join("\n");return`${preamble()}\n(() => Promise.resolve())()\n${addUrlToListsStr};`}function processCard(card){console.log(`card ${card}`);const nameEl=card.querySelector("h1");console.log(`nameEl ${nameEl}`);const name=nameEl.innerText;console.log(`name ${name}`);const descriptionEl=card.querySelector(".c-entry-content p");console.log(`descriptionEl ${descriptionEl}`);const description=descriptionEl.innerText;console.log(`description ${description}`);const servicesEls=Array.from(card.querySelectorAll(".services li a"));console.log(`servicesEls ${servicesEls}`);const gmapsEl=servicesEls.find((a=>"Open in Google Maps"===a.innerHTML));console.log(`gmapsEl ${gmapsEl}`);const gmapsRawLink=gmapsEl.href;console.log(`gmapsRawLink ${gmapsRawLink}`);const gmapsLink=gmapsRawLink.replace("https://google.com","").replace("https://www.google.com","");return console.log(`gmapsLink ${gmapsLink}`),{name:name,description:description,gmaps:gmapsLink}}function scrapeFromPage(){const eaterListTitleEl=document.querySelector(".c-mapstack__headline h1");console.log(`eaterListTitleEl ${eaterListTitleEl}`);const eaterListTitle=eaterListTitleEl.innerText;console.log(`eaterListTitle ${eaterListTitle}`);const updatedEl=document.querySelector('.c-mapstack__headline [data-ui="timestamp"]');console.log(`updatedEl ${updatedEl}`);const updated=updatedEl.innerText;console.log(`updated ${updated}`);const cardEls=Array.from(document.querySelectorAll("#content .c-mapstack__card"));console.log(`cardEls ${cardEls}`);const cards=cardEls.filter((card=>!["intro","newsletter","related-links","comments"].includes(card.getAttribute("data-slug"))));console.log(`cards ${cards}`);const cardData=cards.map(processCard);return console.log(`cardData ${cardData}`),[eaterListTitle,updated,cardData]}function noteForDatum(cardDatum,eaterListTitle,updated){return`Eater - ${eaterListTitle} (updated ${updated})\\n\\n${cardDatum.description}`}function cardDataToMapsData(cardData,eaterListTitle,updated,listName){cardData.length;return cardData.map((cardDatum=>{const note=noteForDatum(cardDatum,eaterListTitle,updated),urlRaw=cardDatum.gmaps,url=(()=>{if(urlRaw.includes("?api=1"))return urlRaw;const[latLong]=urlRaw.split("/").slice(-1);return`https://www.google.com/maps/search/${cardDatum.name}/@${latLong}`})();return{name:cardDatum.name,url:url,note:note,listName:listName}}))}function bookmarklet(){const listName=prompt("please enter the exact name of the google maps list (must already exist!)"),[eaterListTitle,updated,cardData]=scrapeFromPage(),script=genScript(cardDataToMapsData(cardData,eaterListTitle,updated,listName));navigator.clipboard.writeText(script),alert("script copied to clipboard!")}bookmarklet();   ```

   ````

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
1. `node michelin-to-csv.mjs -i './data/michelin.csv' --loc "${LOCATION}" -o "michelin-${LOCATION}.csv`
1. `node csv-to-gmaps-paste-snippet.mjs "michelin-${LOCATION}.csv" > snip.js`
1. ensure you have four lists in google maps
   1. michelin-😋
   1. michelin-⭐
   1. michelin-⭐⭐
   1. michelin-⭐⭐⭐
1. copy/paste contents of `snip.js` into google maps console

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
  - 🧑‍💻 relies on css selectors, so will break every time google deploys new UI for lists
  - 📜 on longer lists tends to fail and get stuck towards the end of the list
    - 🤔 (I suspect this is because when it navigates to a new restaurant it's not doing a full reload (only a partial one) and all previously loaded assets stick around and eventually overload something which causes the script to get stuck)
    - ♻️ can refresh and re-paste (the script is smart enough to skip already saved places) but what I usually do is first paste it into a text editor and delete all the entries it already added

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
