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
