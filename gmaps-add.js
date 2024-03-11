const btnSaveSelector = '[data-value*="Save"]';

let logPrefix = "";

function log(...args) {
  console.log(logPrefix, ...args);
}

function logPrefixSet(prefix) {
  logPrefix = prefix;
}

function rest(val) {
  return new Promise((resolve) => setTimeout(() => resolve(val), 500));
}

function goToUrl(url) {
  log(`goToUrl ${url}`);

  return new Promise((resolve) =>
    fetch(url)
      .then((res) => res.text())
      .then((data) => {
        document.open();
        document.write(data);
        document.close();
      })
      .then(() => resolve())
  );
}

function observeUntilFound(_nodeObserve, nodesFindingSelectors) {
  log(`observeUntilFound ${nodesFindingSelectors}`);

  return new Promise((resolve) =>
    tryToFind(nodesFindingSelectors, resolve, Date.now())
  );
}

function tryToFind(nodesFindingSelectors, resolve, startTime) {
  setTimeout(() => {
    const nodesFinding = nodesFindingSelectors.map((selector) =>
      document.querySelector(selector)
    );
    if (nodesFinding.every((node) => node !== null)) {
      resolve(nodesFinding);
      return;
    }

    const timeElapsedS = (Date.now() - startTime) / 1000;
    log(`🔎 ${nodesFindingSelectors}, ${timeElapsedS} s elapsed... `);
    tryToFind(nodesFindingSelectors, resolve, startTime);
  }, 400);
}

function waitUntilClickable(btn) {
  log(`waitUntilClickable ${btn}`);

  return new Promise((resolve) => checkClickable(btn, resolve, Date.now()));
}

function checkClickable(btn, resolve, startTime) {
  setTimeout(() => {
    if (typeof btn.click === "function") {
      resolve(btn);
      return;
    }

    const timeElapsedS = (Date.now() - startTime) / 1000;
    log(`🖱️❓ ${btn}, ${timeElapsedS} s elapsed...`);
    checkClickable(btn, resolve, startTime);
  }, 200);
}

function addUrlToList(name, url, listName, note, loggingNote) {
  logPrefixSet(`[gmaps-add][${name}][${loggingNote}]`);

  return goToUrl(url)
    .then(rest)
    .then(() => observeUntilFound(document, [btnSaveSelector]))
    .then(rest)
    .then(([btnSave]) => waitUntilClickable(btnSave))
    .then(rest)
    .then((btnSave) => btnSave.click())
    .then(rest)
    .then(() =>
      observeUntilFound(document.querySelector("#hovercard"), ["#action-menu"])
    )
    .then(([menu]) =>
      Array.from(menu.querySelectorAll("div")).find(
        (div) => div.innerText === listName
      )
    )
    .then(rest)
    .then((menuItemList) => {
      if (menuItemList.getAttribute("aria-checked") === "true") {
        log(`already saved to ${listName}`);
        return;
      }

      return waitUntilClickable(menuItemList)
        .then(rest)
        .then((menuItemList) => menuItemList.click())
        .then(rest)
        .then(() =>
          observeUntilFound(document.querySelector('[role="main"]'), [
            `[aria-label="Add note in ${listName}"]`,
          ])
        )
        .then(rest)
        .then(([btnAddNote]) => waitUntilClickable(btnAddNote))
        .then(rest)
        .then((btnAddNote) => btnAddNote.click())
        .then(rest)
        .then(() =>
          observeUntilFound(document.querySelector("#modal-dialog"), [
            "#modal-dialog textarea",
          ])
        )
        .then(rest)
        .then(([textarea]) => {
          const btns = document.querySelectorAll("#modal-dialog button");
          const btnConfirm = Array.from(btns).find(
            (btn) => btn.innerText === "DONE"
          );
          textarea.value = note;
          btnConfirm.click();
        })
        .then(rest);
    });
}
