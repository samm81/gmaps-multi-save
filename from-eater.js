// terser concats `make-gmaps-paste-snippet` which contains `genScript`

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

function cardDataToMapsData(cardData, eaterListTitle, updated) {
  const cardDataCount = cardData.length;
  return cardData.map((cardDatum) => {
    const note = noteForDatum(cardDatum, eaterListTitle, updated);
    const urlRaw = cardDatum.gmaps;
    const url = (() => {
      if (urlRaw.includes("?api=1")) return urlRaw;
      const [latLong] = urlRaw.split("/").slice(-1);
      return `https://www.google.com/maps/search/${cardDatum.name}/@${latLong}`;
    })();
    return { name: cardDatum.name, url, note };
  });
}

function bookmarklet() {
  const listName = prompt(
    "please enter the exact name of the google maps list (must already exist!)"
  );

  const [eaterListTitle, updated, cardData] = scrapeFromPage();
  const mapsData = cardDataToMapsData(cardData, eaterListTitle, updated);
  const script = genScript(mapsData, listName);
  navigator.clipboard.writeText(script);

  alert("script copied to clipboard!");
}

bookmarklet();
