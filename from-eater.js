function preamble() {
  return `
placeholder for content of bookmarklet-eater-gmaps-save-to-list-helper.js
`;
}

function processCard(card) {
  console.log(`card ${card}`);
  const nameEl = card.querySelector("h1");
  console.log(`nameEl ${nameEl}`);
  const name = nameEl.innerText;
  console.log(`name ${name}`);
  const descriptionEl = card.querySelector(".c-entry-content p");
  console.log(`descriptionEl ${descriptionEl}`);
  const description = descriptionEl.innerText;
  console.log(`description ${description}`);
  const servicesEls = Array.from(card.querySelectorAll(".services li a"));
  console.log(`servicesEls ${servicesEls}`);
  const gmapsEl = servicesEls.find(
    (a) => a.innerHTML === "Open in Google Maps"
  );
  console.log(`gmapsEl ${gmapsEl}`);
  const gmapsRawLink = gmapsEl.href;
  console.log(`gmapsRawLink ${gmapsRawLink}`);
  const gmapsLink = gmapsRawLink
    .replace("https://google.com", "")
    .replace("https://www.google.com", "");
  console.log(`gmapsLink ${gmapsLink}`);

  return {
    name,
    description,
    gmaps: gmapsLink,
  };
}

function scrapeFromPage() {
  const eaterListTitleEl = document.querySelector(".c-mapstack__headline h1");
  console.log(`eaterListTitleEl ${eaterListTitleEl}`);
  const eaterListTitle = eaterListTitleEl.innerText;
  console.log(`eaterListTitle ${eaterListTitle}`);
  const updatedEl = document.querySelector(
    '.c-mapstack__headline [data-ui="timestamp"]'
  );
  console.log(`updatedEl ${updatedEl}`);
  const updated = updatedEl.innerText;
  console.log(`updated ${updated}`);

  const cardEls = Array.from(
    document.querySelectorAll("#content .c-mapstack__card")
  );
  console.log(`cardEls ${cardEls}`);
  const cards = cardEls.filter(
    (card) =>
      !["intro", "newsletter", "related-links", "comments"].includes(
        card.getAttribute("data-slug")
      )
  );
  console.log(`cards ${cards}`);
  const cardData = cards.map(processCard);
  console.log(`cardData ${cardData}`);

  return [eaterListTitle, updated, cardData];
}

function noteForDatum(cardDatum, eaterListTitle, updated) {
  return `Eater - ${eaterListTitle} (updated ${updated})\\n\\n${cardDatum.description}`;
}

function escapeSingleQuotes(str) {
  return str.replace(/'/g, "\\'");
}

function genScript(cardData, listName, eaterListTitle, updated) {
  const cardDataCount = cardData.length;
  const addUrlToListsStr = cardData
    .map((cardDatum, index) => {
      const note = noteForDatum(cardDatum, eaterListTitle, updated);
      const url = cardDatum.gmaps;
      return `.then(() => addUrlToList("${
        cardDatum.name
      }", "${url}", "${listName}", '${escapeSingleQuotes(note)}', "[${
        index + 1
      } / ${cardDataCount}]"))`;
    })
    .join("\n");

  return `${preamble()}\n(() => Promise.resolve())()\n${addUrlToListsStr};`;
}

function bookmarklet() {
  const listName = prompt(
    "please enter the exact name of the google maps list (must already exist!)"
  );

  const [eaterListTitle, updated, cardData] = scrapeFromPage();
  const script = genScript(cardData, listName, eaterListTitle, updated);
  navigator.clipboard.writeText(script);

  alert("script copied to clipboard!");
}

bookmarklet();
