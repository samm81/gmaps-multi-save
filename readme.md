<!-- DO NOT MODIFY THIS FILE DIRECTLY -->
<!-- instead modify readme.tmpl.md and run `make readme.md` -->

# gmaps-multi-save

google maps saved lists are great. before I travel anywhere I fill up my lists with possible places to eat, drink, shop, and tour. I populate from sites like eater, michelin guide, timeout, and lonely planet.

populating these lists used to be a terribly manual ordeal. not anymore 😎

### setup

1. create a new bookmark
1. copy/paste the following code into the URL field

   ```javascript
   javascript:(()=>{function processCard(card){console.log(`card ${card}`);const nameEl=card.querySelector("h1");console.log(`nameEl ${nameEl}`);const name=nameEl.innerText;console.log(`name ${name}`);const descriptionEl=card.querySelector(".c-entry-content p");console.log(`descriptionEl ${descriptionEl}`);const description=descriptionEl.innerText;console.log(`description ${description}`);const servicesEls=Array.from(card.querySelectorAll(".services li a"));console.log(`servicesEls ${servicesEls}`);const gmapsEl=servicesEls.find((a=>"Open in Google Maps"===a.innerHTML));console.log(`gmapsEl ${gmapsEl}`);const gmapsRawLink=gmapsEl.href;console.log(`gmapsRawLink ${gmapsRawLink}`);const gmapsLink=gmapsRawLink.replace("https://google.com","").replace("https://www.google.com","");return console.log(`gmapsLink ${gmapsLink}`),{name:name,description:description,gmaps:gmapsLink}}!function(){const listName=prompt("please enter the exact name of the google maps list (must already exist!)"),[eaterListTitle,updated,cardData]=function(){const eaterListTitleEl=document.querySelector(".c-mapstack__headline h1");console.log(`eaterListTitleEl ${eaterListTitleEl}`);const eaterListTitle=eaterListTitleEl.innerText;console.log(`eaterListTitle ${eaterListTitle}`);const updatedEl=document.querySelector('.c-mapstack__headline [data-ui="timestamp"]');console.log(`updatedEl ${updatedEl}`);const updated=updatedEl.innerText;console.log(`updated ${updated}`);const cardEls=Array.from(document.querySelectorAll("#content .c-mapstack__card"));console.log(`cardEls ${cardEls}`);const cards=cardEls.filter((card=>!["intro","newsletter","related-links","comments"].includes(card.getAttribute("data-slug"))));console.log(`cards ${cards}`);const cardData=cards.map(processCard);return console.log(`cardData ${cardData}`),[eaterListTitle,updated,cardData]}(),script=function(cardData,listName,eaterListTitle,updated){const cardDataCount=cardData.length,addUrlToListsStr=cardData.map(((cardDatum,index)=>{const note=function(cardDatum,eaterListTitle,updated){return`Eater - ${eaterListTitle} (updated ${updated})\\n\\n${cardDatum.description}`}(cardDatum,eaterListTitle,updated),url=cardDatum.gmaps;return`.then(() => addUrlToList("${cardDatum.name}", "${url}", "${listName}", '${str=note,str.replace(/'/g,"\\'")}', "[${index+1} / ${cardDataCount}]"))`;var str})).join("\n");return`\nconst btnSaveSelector='[jsaction*="pane.placeActions.save"]';let logPrefix="";function log(...args){console.log(logPrefix,...args)}function logPrefixSet(prefix){logPrefix=prefix}function rest(val){return new Promise((resolve=>setTimeout((()=>resolve(val)),500)))}function goToUrl(url){return log(\`goToUrl \${url}\`),new Promise((resolve=>fetch(url).then((res=>res.text())).then((data=>{document.open(),document.write(data),document.close()})).then((()=>resolve()))))}function observeUntilFound(_nodeObserve,nodesFindingSelectors){return log(\`observeUntilFound \${nodesFindingSelectors}\`),new Promise((resolve=>tryToFind(nodesFindingSelectors,resolve,Date.now())))}function tryToFind(nodesFindingSelectors,resolve,startTime){setTimeout((()=>{const nodesFinding=nodesFindingSelectors.map((selector=>document.querySelector(selector)));if(nodesFinding.every((node=>null!==node)))return void resolve(nodesFinding);const timeElapsedS=(Date.now()-startTime)/1e3;log(\`🔎 \${nodesFindingSelectors}, \${timeElapsedS} s elapsed... \`),tryToFind(nodesFindingSelectors,resolve,startTime)}),400)}function waitUntilClickable(btn){return log(\`waitUntilClickable \${btn}\`),new Promise((resolve=>checkClickable(btn,resolve,Date.now())))}function checkClickable(btn,resolve,startTime){setTimeout((()=>{if("function"==typeof btn.click)return void resolve(btn);const timeElapsedS=(Date.now()-startTime)/1e3;log(\`🖱️❓ \${btn}, \${timeElapsedS} s elapsed...\`),checkClickable(btn,resolve,startTime)}),200)}function addUrlToList(name,url,listName,note,loggingNote){return logPrefixSet(\`[gmaps-add][\${name}][\${loggingNote}]\`),goToUrl(url).then(rest).then((()=>observeUntilFound(document,[btnSaveSelector]))).then(rest).then((([btnSave])=>waitUntilClickable(btnSave))).then(rest).then((btnSave=>btnSave.click())).then(rest).then((()=>observeUntilFound(document.querySelector("#hovercard"),["#action-menu"]))).then((([menu])=>Array.from(menu.querySelectorAll("div")).find((div=>div.innerText===listName)))).then(rest).then((menuItemList=>{if("true"!==menuItemList.getAttribute("aria-checked"))return waitUntilClickable(menuItemList).then(rest).then((menuItemList=>menuItemList.click())).then(rest).then((()=>observeUntilFound(document.querySelector('[role="main"]'),[\`[aria-label="Add note in \${listName}"]\`]))).then(rest).then((([btnAddNote])=>waitUntilClickable(btnAddNote))).then(rest).then((btnAddNote=>btnAddNote.click())).then(rest).then((()=>observeUntilFound(document.querySelector("#modal-dialog"),["#modal-dialog textarea",'[data-id="confirm"]']))).then(rest).then((([textarea,btnConfirm])=>{textarea.value=note,btnConfirm.click()})).then(rest);log(\`already saved to \${listName}\`)}))}\n\n(() => Promise.resolve())()\n${addUrlToListsStr};`}(cardData,listName,eaterListTitle,updated);navigator.clipboard.writeText(script),alert("script copied to clipboard!")}()})();
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
