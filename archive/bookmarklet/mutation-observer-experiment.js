function observeUntilFound(nodeObserve, nodesFindingSelectors) {
  console.log(`observeUntilFound ${nodeObserve} ${nodesFindingSelectors}`);

  return new Promise((resolve) => {
    const observer = new MutationObserver((_mutationList, observer) => {
      const nodesFinding = nodesFindingSelectors.map((selector) =>
        document.querySelector(selector)
      );
      if (nodesFinding.some((node) => node === null)) return;
      observer.disconnect();
      resolve(nodesFinding);
    });
    observer.observe(nodeObserve, { childList: true, subtree: true });
  });
}
