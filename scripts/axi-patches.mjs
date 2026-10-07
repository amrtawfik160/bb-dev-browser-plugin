// Fixes applied to the bundled chrome-devtools-axi CLI by vendor-axi.mjs.
//
// After `new_page`, axi selects the created page only when exactly one listed
// page has the URL it asked for. A redirect (localhost:5199 to /dashboard) or
// a second tab on the same URL leaves nothing selected, so `open` fails with
// "No page is currently selected" and every retry opens another tab.
// chrome-devtools-mcp selects the page `new_page` created and marks it
// `[selected]` in the same listing, so that mark identifies the page.
//
// `snapshot` with no selected page used to fail even when one tab was open.
// That command now selects the only open page before it reads the tree.

const PATCHES = [
  {
    anchor: `function createdPageIdFromNewPageDump(text, requestedUrl) {
  let inPages = false;
  let matchedIds = [];
  let incomplete = false;`,
    replacement: `function createdPageIdFromNewPageDump(text, requestedUrl) {
  let inPages = false;
  let matchedIds = [];
  let incomplete = false;
  let selectedId = null;`,
  },
  {
    anchor: `    if (MCP_PAGES_HEADER.test(line)) {
      inPages = true;
      matchedIds = [];
      incomplete = false;
      continue;
    }`,
    replacement: `    if (MCP_PAGES_HEADER.test(line)) {
      inPages = true;
      matchedIds = [];
      incomplete = false;
      selectedId = null;
      continue;
    }`,
  },
  {
    anchor: `    const id = Number.parseInt(m[1], 10);
    const rest = m[2];
    if (!isCompletePageLabel(rest)) {`,
    replacement: `    const id = Number.parseInt(m[1], 10);
    const rest = m[2];
    if (/\\s\\[selected\\](?:\\s+isolatedContext=.*)?$/.test(rest))
      selectedId = id;
    if (!isCompletePageLabel(rest)) {`,
  },
  {
    anchor: `      matchedIds.push(id);
  }
  if (incomplete)
    return null;`,
    replacement: `      matchedIds.push(id);
  }
  if (selectedId !== null)
    return selectedId;
  if (incomplete)
    return null;`,
  },
  {
    anchor: `async function handleSnapshot(full) {
  const snapshot = await stampFresh();
  return formatPageOutput(snapshot, "snapshot", void 0, full);
}`,
    replacement: `async function handleSnapshot(full) {
  if (getSelectedPageId() === null) {
    const listed = parsePagesList(await callTool("list_pages"));
    if (listed.length === 1) setSelectedPageId(listed[0].id);
  }
  const snapshot = await stampFresh();
  return formatPageOutput(snapshot, "snapshot", void 0, full);
}`,
  },
];

export function patchAxiCli(source) {
  let patched = source;
  for (const { anchor, replacement } of PATCHES) {
    const occurrences = patched.split(anchor).length - 1;
    if (occurrences !== 1) {
      throw new Error(
        `chrome-devtools-axi patch anchor found ${occurrences} times; review scripts/axi-patches.mjs against the new axi release:\n${anchor}`,
      );
    }
    patched = patched.replace(anchor, replacement);
  }
  return patched;
}
