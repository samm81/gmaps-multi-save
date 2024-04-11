function preamble() {
  return `
placeholder for content of bookmarklet-eater-gmaps-save-to-list-helper.js
`;
}

function escapeSingleQuotes(str) {
  return str.replace(/'/g, "\\'");
}

function genScript(data) {
  const dataCount = data.length;
  const addUrlToListsStr = data
    .map(({ name, url, note, listName }, index) => {
      const loggingNote = `[${index + 1} / ${dataCount}]`;
      const noteSafe = escapeSingleQuotes(note);
      return `.then(() => addUrlToList("${name}", "${url}", "${listName}", '${noteSafe}', "${loggingNote}"))`;
    })
    .join("\n");

  return `${preamble()}\n(() => Promise.resolve())()\n${addUrlToListsStr};`;
}
