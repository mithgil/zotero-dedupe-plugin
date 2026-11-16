# Zotero Dedupe Plugin

A Zotero 7/8/9 add-on that exposes a local duplicate-check endpoint for the
`zotero-dedupe-extension` browser extension.

The official Zotero Connector saves items without asking whether they already
exist. This plugin lets a custom browser extension check the local Zotero
library first, then decide whether to save.

## Components

This project has two parts:

| Component | Repository | Version |
| --- | --- | --- |
| Zotero plugin (this repo) | `zotero-dedupe-plugin` | 1.1.6 |
| Browser extension | [`../zotero-dedupe-extension`](../zotero-dedupe-extension/README.md) | 1.3.3 |

The plugin is the Zotero-side service:

- duplicate checks against the local library
- collection listing
- saving items into a chosen collection
- attaching PDFs as child attachments

The browser extension is the UI:

- reads citation metadata from the page
- calls the plugin before saving
- shows the duplicate warning and collection picker
- downloads the PDF with the browser session
- shows the result window and progress spinner

The extension README is at
[`../zotero-dedupe-extension/README.md`](../zotero-dedupe-extension/README.md).

## Features

- Duplicate check before saving: DOI, ISBN, PMID, arXiv ID, fuzzy title
- Explicit duplicate warning; saving requires **Save anyway**
- Collection picker, including **Library root** and a search filter
- PDF capture with browser cookies / `Referer`, attached to the saved item
- Result window with library, collection path, item key, and PDF status
- Progress spinner for duplicate check, save, and PDF attach
- Saves into the same target collection that Zotero Connector would use

## Why a plugin and an extension?

Zotero's local HTTP API is read-only. An extension alone cannot:

- query the local library for duplicates
- list collections
- write an item into a collection
- attach a PDF

The plugin runs inside Zotero and exposes a small local JSON API. The browser
extension is the front end that talks to `127.0.0.1:23119`.

All communication stays on localhost.

## Architecture

```
Browser page
  └─ zotero-dedupe-extension (content script)
       └─ background service worker
            ├─ POST http://127.0.0.1:23119/dedupe/check
            ├─ GET  http://127.0.0.1:23119/dedupe/collections
            ├─ POST http://127.0.0.1:23119/dedupe/save
            └─ POST http://127.0.0.1:23119/dedupe/save-pdf
```

Zotero already runs its local HTTP server on port **23119**. The plugin does
not open port 23120; it registers endpoints on Zotero's server.

The extension downloads an accessible PDF in the browser (so browser cookies
are used when the publisher allows it), sends the bytes to `/dedupe/save-pdf`,
and the plugin stores it as a child attachment of the saved item.

## Requirements

- Zotero 7 or newer (tested against Zotero 9.0.2)
- Zotero's local HTTP server enabled (default)

## Build

```bash
./build.sh
```

This produces `zotero-dedupe.xpi`.

## Install

1. In Zotero: **Tools → Plugins**.
2. Click the gear icon → **Install Plugin From File…**.
3. Select `zotero-dedupe.xpi`.
4. Restart Zotero if prompted.

Verify that the endpoint is alive:

```bash
curl http://127.0.0.1:23119/dedupe/check
```

Expected response:

```json
{"ok":true,"available":true,"name":"Zotero Dedupe", ...}
```

### Companion browser extension

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the sibling directory:

   ```text
   ../zotero-dedupe-extension
   ```

5. Pin **Zotero Dedupe** from the puzzle-piece menu.
6. Open a paper page and refresh it once.

The extension version should be **1.3.3** or newer. See
[`../zotero-dedupe-extension/README.md`](../zotero-dedupe-extension/README.md)
for permissions, PDF troubleshooting, and development notes.

## API

### `GET /dedupe/check`

Health check. Returns plugin and Zotero version information, including the
current save target:

```json
{
  "ok": true,
  "version": "1.1.6",
  "target": {
    "library": { "name": "My Library", "editable": true },
    "collection": { "key": "COLL0002", "path": "Papers / 2026" },
    "path": "My Library / Papers / 2026"
  }
}
```

### `POST /dedupe/check`

Request body:

```json
{
  "item": {
    "itemType": "journalArticle",
    "title": "Example title",
    "DOI": "10.1234/example",
    "ISBN": "",
    "date": "2024",
    "creators": [
      { "creatorType": "author", "firstName": "Ada", "lastName": "Lovelace" }
    ],
    "extra": "",
    "url": "https://example.com/article"
  },
  "options": {
    "libraryID": 1,
    "excludeItemID": 123
  }
}
```

Both `item` and `options` are optional wrappers; a bare item object is also
accepted. `libraryID` defaults to the user library.

Response:

```json
{
  "ok": true,
  "available": true,
  "duplicate": true,
  "matchReason": "DOI",
  "matchValue": "10.1234/example",
  "confidence": 1,
  "match": {
    "itemID": 42,
    "key": "ABCD1234",
    "title": "Example title",
    "date": "2024",
    "...": "..."
  },
  "existingItemKey": "ABCD1234",
  "existingItemID": 42
}
```

Matching order:

1. DOI (normalized)
2. ISBN (hyphens/spaces ignored, multiple ISBNs supported)
3. PMID
4. arXiv ID (from `extra`, `archiveLocation`, URL, or `10.48550/arXiv.*` DOI)
5. Fuzzy title match, weighted by year and first author

Fuzzy matching only runs when no identifier matches. Candidates are restricted
to regular top-level items and deleted items are excluded.

### `GET /dedupe/collections`

Lists the collections in the current library so the extension can show a
collection picker:

```json
{
  "ok": true,
  "library": { "name": "My Library" },
  "selectedCollectionID": 2,
  "collections": [
    { "collectionID": 1, "key": "COLL0001", "path": "Papers", "level": 0 },
    { "collectionID": 2, "key": "COLL0002", "path": "Papers / 2026", "level": 1 }
  ]
}
```

### `POST /dedupe/save`

Saves an item into:

- `options.collectionID` if provided (`0` means library root), or
- the collection currently selected in Zotero when no override is provided.

The target logic is the same as Zotero Connector. The response returns the saved
item and target path:

```json
{
  "item": { "itemID": 42, "key": "ABCD1234", "title": "Example title" },
  "target": {
    "library": { "name": "My Library" },
    "collection": { "key": "COLL0002", "path": "Papers / 2026" },
    "path": "My Library / Papers / 2026"
  }
}
```

Example request overriding the collection:

```json
{
  "item": { "itemType": "journalArticle", "title": "Example title" },
  "options": { "collectionID": 2 }
}
```

### `POST /dedupe/save-pdf`

Preferred: raw PDF body (`Content-Type: application/pdf`) with the metadata in
headers:

```text
X-Zotero-Dedupe-Item-ID: 42
X-Zotero-Dedupe-Title: Full%20Text%20PDF
X-Zotero-Dedupe-URL: https%3A%2F%2Fexample.com%2Fpaper.pdf
```

The stream is passed directly to `Zotero.Attachments.importFromNetworkStream()`,
which avoids base64 and an extra file copy.

For compatibility, a JSON request is also accepted:

```json
{
  "itemID": 42,
  "title": "Full Text PDF",
  "url": "https://example.com/paper.pdf",
  "data": "JVBERi0xLjQK..."
}
```

`data` is a base64-encoded PDF. The plugin validates the `%PDF-` header, writes
it to a temporary file, imports it as a child attachment, and removes the
temporary file.

## Privacy

- The plugin listens only on Zotero's existing `127.0.0.1:23119` server.
- No data is sent to an external server.
- The extension reads cookies only for the PDF host and uses them only for the
  PDF download request.
- Cookies are not sent to Zotero; Zotero receives the PDF bytes, not the
  browser cookies.

## Troubleshooting

**"The add-on could not be installed. It may be incompatible with this version
of Zotero."**

The old version of this plugin was a legacy XUL overlay add-on (`install.rdf`).
Zotero 7 and newer only support bootstrapped plugins with `manifest.json` and a
`bootstrap.js`. This repository now uses that format.

Zotero 9 also requires `applications.zotero.update_url` in `manifest.json`.
Without it, the installer shows the same generic “could not be installed”
message. The manifest now includes a placeholder update URL.

If an old **Zotero Dedupe Plugin** entry is still listed in Tools → Plugins,
remove it first, then install the rebuilt `zotero-dedupe.xpi`.

**The extension cannot reach the plugin**

- Confirm Zotero is running.
- Check `curl http://127.0.0.1:23119/dedupe/check`.
- Make sure the browser extension is posting to **23119**, not 23120.
- Look at Zotero's debug output (`Help → Debug Output Logging → Enable`) for
  `[zotero-dedupe]` messages.

**I copied the XPI into the profile but Zotero ignores it**

An existing Zotero profile only scans side-loaded add-ons when the profile scope
is in `extensions.startupScanScopes`. For a one-time sideload, set:

```javascript
user_pref("extensions.autoDisableScopes", 0);
user_pref("extensions.startupScanScopes", 1);
```

Then restart Zotero. Installing through **Tools → Plugins → Install Plugin From
File…** does not need these preferences.

## Development

Reload after editing `bootstrap.js` by disabling and re-enabling the plugin in
Tools → Plugins, or restart Zotero. Then rebuild the XPI with `./build.sh`.

The browser side is developed separately:

```text
../zotero-dedupe-extension
```

After changing `content.js`, `background.js`, `popup.js`, or `manifest.json`,
reload the unpacked extension on `chrome://extensions` and refresh the article
page.

### Version pairing

| Plugin | Extension |
| --- | --- |
| 1.1.6 | 1.3.3 |

The extension requires plugin **1.1.6** or newer for:

- raw PDF stream upload (`/dedupe/save-pdf`)
- collection picker (`/dedupe/collections`)
- save target override (`options.collectionID`)
