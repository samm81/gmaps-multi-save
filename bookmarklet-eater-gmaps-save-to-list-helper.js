function rest(val) {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve(val);
    }, 500);
  });
}

function goToUrl(url) {
  console.log(`goToUrl ${url}`);

  return new Promise((resolve) => {
    fetch(url)
      .then((res) => res.text())
      .then((data) => {
        document.open();
        document.write(data);
        document.close();
      })
      .then(() => resolve());
  });
}

function observeUntilFound(_nodeObserve, nodesFindingSelectors) {
  console.log(`observeUntilFound ${nodesFindingSelectors}`);

  return new Promise((resolve) => tryToFind(nodesFindingSelectors, resolve));
}

function tryToFind(nodesFindingSelectors, resolve) {
  setTimeout(() => {
    const nodesFinding = nodesFindingSelectors.map((selector) =>
      document.querySelector(selector)
    );
    if (nodesFinding.every((node) => node !== null))
      return resolve(nodesFinding);
    tryToFind(nodesFindingSelectors, resolve);
  }, 400);
}

function waitUntilClickable(btn) {
  console.log(`waitUntilClickable ${btn}`);

  return new Promise((resolve) => {
    const checkClick = () => {
      setTimeout(() => {
        if (typeof btn.click === "function") {
          resolve(btn);
          return;
        }
        checkClick();
      }, 200);
    };
    checkClick();
  });
}

function handleCard(url, listName, note) {
  return goToUrl(url)
    .then(rest)
    .then(() =>
      observeUntilFound(document, [
        '[jsaction="pane.placeActions.save;keydown:pane.placeActions.save"]',
      ])
    )
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
    .then((btnList) => waitUntilClickable(btnList))
    .then(rest)
    .then((btnList) => btnList.click())
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
        '[jsaction="pane.footer.confirm"]',
      ])
    )
    .then(rest)
    .then(([textarea, btnConfirm]) => {
      textarea.value = note;
      btnConfirm.click();
    })
    .then(rest);
}
