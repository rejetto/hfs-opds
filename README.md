# HFS OPDS

Browse HFS ebook folders from an OPDS 1.2 reader, using the same accounts, permissions and downloads as HFS.
Requires **HFS 3.3.0 or newer**. No runtime dependencies or database.

## Installation

Install through **HFS Admin → Plugins → Get more**: search for **opds** and install it.
Return to the installed plugins list and click the **Options button on the opds plugin's row** to configure it.

Enabling the plugin enables its OPDS service. Its Options can disable the service separately, choose book extensions,
set the page size (100 by default, maximum 1000), and override the catalog title.
The extension setting selects from EPUB, PDF, MOBI, AZW, AZW3, CBZ and CBR; it does not add new formats.

## Usage

Add a folder URL to your reader, for example:

```text
https://example.com/books/?get=opds
https://example.com/books/scifi/?get=opds
```

The HFS folder menu includes **Copy OPDS catalog URL** for folders you can list.
Virtual folders work too. Folders with subfolders provide navigation feeds, with **Books in this folder**
linking to `?get=opds&opds_view=books` when publications are also present.
Folders containing only books, or no eligible entries, provide acquisition feeds directly.
Both kinds of feed are paginated; readers follow Atom `next` and `previous` links.

Book titles come from filenames without their extension. HFS supplies modification dates;
virtual folders without dates use the Unix epoch. IDs stay stable across pagination, proxy-prefix changes
and hostname changes, but change when the VFS path changes. A small `storage/catalog-id` file gives each
installation its own ID namespace; retain it during migrations. Downloads use ordinary HFS file URLs.
Unsupported files, remote URL shortcuts, hidden items, unlistable folders and unreadable books are excluded.

## Authentication and proxies

Configure the reader with your existing HFS username and password. HFS handles HTTP Basic authentication
when its `authorization_header` setting is enabled (the default). Existing browser sessions also work.
Use HTTPS for password authentication. Existing HFS restrictions and authentication plugins still apply;
clients that cannot complete an extra login step may be incompatible.
An unauthenticated request to a folder requiring login receives a Basic challenge.
Like normal HFS browsing, direct access checks the folder's listing permission;
a folder hidden from its parent's listing can still be opened through its known URL when listing is allowed.
Credentials and session tokens are never added to generated links.

Links follow HFS's proxy-aware request scheme and host, its host-root mapping and `X-Forwarded-Prefix`.
Configure HFS's reverse-proxy settings normally and have the proxy supply the public scheme, host and prefix.
The plugin uses the request's public address, rather than HFS's optional `base_url` override.

## Development and tests

All distributed files are in `dist`. For a local checkout:

```sh
ln -s /absolute/path/hfs-opds/dist ~/.hfs/plugins/opds
```

Enable **opds** in HFS Admin. Run `npm test` with the sibling `../../hfs` checkout built and its dependencies installed,
or set `HFS_ROOT` to another HFS checkout. Tests use Node's test runner and HFS's existing XML parser;
they launch an isolated HFS server with temporary files and accounts. They never use your live HFS configuration.

```sh
npm test
HFS_SOURCE=1 npm test           # current TypeScript sources, using HFS's tsx
HFS_SOURCE=1 HFS_CACHE=1 npm test
HFS_UI=1 npm test              # also uses HFS's Playwright and installed Chromium
```

Tests cover XML, navigation, acquisition downloads, permissions, Basic authentication, virtual/nested folders,
Unicode and XML-sensitive filenames, pagination, IDs, host roots, proxy prefixes, invalid requests,
configuration changes and normal browsing. The optional browser test checks the folder-menu action.

Manual interoperability was tested with **Thorium Reader 3.5.1 on macOS Apple Silicon**:
navigation, pagination, Unicode filenames, EPUB download/import/reading and authenticated downloads worked.
The initial Basic login displayed a 401 error; using the reader's Reload link then opened the private catalog.
See [the test report](tests/interop-thorium.md) for the scope and reproduction steps.

## Limits and future work

- **KOReader and Moon+ Reader interoperability is unverified**; neither client was available for testing.
- No metadata extraction, covers, search, conversion, recursive library index or OPDS 2.0. These can be optional later additions.
- Each request enumerates one directory and sorts eligible entries. XML output is bounded by page size, but listing memory/work
  still grows with directory size. HFS's directory cache is reused when available; it is not required.
- Pagination reflects the current directory; additions and removals between page requests can shift entries.
- The VFS functions currently require `api.require('./vfs')`, because HFS has no public directory-listing API.
  They preserve HFS masks, virtual names, visibility and permission hooks, but changes to these internals may require plugin updates.

Format: [OPDS 1.2 specification](https://specs.opds.io/opds-1.2).
AZW uses the established `application/vnd.amazon.ebook` type; AZW3 uses the
[IANA-registered `application/vnd.amazon.mobi8-ebook`](https://www.iana.org/assignments/media-types/application/vnd.amazon.mobi8-ebook).

MIT license.
