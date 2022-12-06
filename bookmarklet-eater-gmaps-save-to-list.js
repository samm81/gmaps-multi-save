//javascript:
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

  return [eaterListTitle, cardData];
}

function noteForDatum(cardDatum, eaterListTitle) {
  return "Eater - " + eaterListTitle + "\\n\\n" + cardDatum.description;
}

function genScript(cardData, listName, eaterListTitle) {
  const handleCardsStr = cardData
    .map((cardDatum) => {
      const note = noteForDatum(cardDatum, eaterListTitle);
      const url = cardDatum.gmaps;
      return `.then(() => handleCard("${url}", "${listName}", '${note}'))`;
    })
    .join("\n");

  return `(() => Promise.resolve())()\n${handleCardsStr};`;
}

function bookmarklet() {
  const listName = "paris";

  const [eaterListTitle, cardData] = scrapeFromPage();
  const script = genScript(cardData, listName, eaterListTitle);
  navigator.clipboard.writeText(script);

  alert("script copied to clipboard!");
}

bookmarklet();
