# gmaps-multi-save

google maps saved lists are great. before I travel anywhere I fill up my lists with possible places to eat, drink, shop, and tour. I populate from sites like eater, michelin guide, timeout, and lonely planet.

populating these lists used to be a terribly manual ordeal. not anymore 😎

### setup

1. create a new bookmark
1. copy/paste the following code into the URL field

```javascript
javascript: alert("eater-gmaps bookmarklet placeholder");
```

1. save the bookmark

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

### notes

high likelihood of bugs and weird behavior. this relies on css selectors, which would break every time google deploys new UI for lists. I also find that for longer lists, it tends to get stuck towards the end of the list since when it navigates to a new restaurant it's not doing a full reload (only a partial one) and (I think) all the assets it loaded for the previous restaurants stick around too and eventually overload something which causes the script to get stuck. you can try to refresh and re-paste (the script is smart enough to skip already saved places) but what I usually do is paste it into a text editor and delete all the entries it already added so as to speed it up.

please submit any bugs here on github.

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
