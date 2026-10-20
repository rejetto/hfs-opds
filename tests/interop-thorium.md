# Thorium Reader interoperability

Tested on 2026-10-20 with the official [Thorium Reader 3.5.1 arm64 release](https://github.com/edrlab/thorium-reader/releases/tag/v3.5.1),
running on macOS with a fresh, separate `--user-data-dir` profile.
Server: isolated HFS 3.4.0-rc5 build, Node 24.16.0, plugin version 1, directory cache disabled.
The test used the actual Thorium GUI, controlled through macOS accessibility. No client parser was mocked.

## Setup and observed results

1. Create valid EPUB 3 test books `Alpha`, `Beta`, `Delta`, `Gamma`, `Étoile`, plus `Scifi/Voyage`.
   Each book contains a chapter with the text “HFS OPDS interoperability verified with a real reader.”
2. Share them at `/books/`, deny reading `Beta.epub` while leaving it visible, and set OPDS page size to 2.
3. In Thorium's **Catalogs → Add OPDS feed**, add the server's `/?get=opds` URL.
4. Open **books → Books in this folder**. Thorium shows `Alpha` and `Delta` on page 1.
   Follow **Next**: page 2 shows `Gamma` and `Étoile`. `Beta` is absent from both pages.
5. Open `Étoile`, click **Import (EPUB)**, then open it from **All publications**.
   Thorium reports a completed import and renders the chapter and its test sentence correctly.
6. Add `/private/?get=opds`, sharing the same files with listing and reading restricted to a temporary HFS account.
   The reader opens its native Login dialog. Enter the temporary account credentials there, without putting them in the URL.
7. Immediately after login, the reader showed **401: Unauthorized**. Clicking its **reload** link opened the private catalog.
   This observation does not establish whether the initial error comes from Thorium or HFS; no authentication workaround was added.
8. Open **Scifi → Voyage → Import (EPUB)** in the protected catalog.
   Thorium reports **Importing [Voyage] completed**. The downloaded file matches the protected source byte for byte.

Both imported files were independently compared with the source EPUBs using SHA-256:

| Publication | Source and imported file SHA-256 |
| --- | --- |
| Étoile.epub | `e9881c268d68ccb57d8274a538e4601f68c0ca1b04a0ca5a8bb76ebe59d286d5` |
| Voyage.epub | `6c0242130f8e8c9d5cb8844855c987322a0c752b407870720cbaa88f5bb0b8b4` |

## Scope

This verifies real client navigation, acquisition feeds, next-page links, Unicode filenames,
visibility filtering, a Basic login challenge, subsequent authenticated browsing, protected acquisition
and importing/reading a valid EPUB. It does not establish interoperability with every OPDS client or book format.

KOReader, Moon+ Reader, other publication formats, HTTPS/reverse proxies, MFA and non-ASCII credentials
were not tested with Thorium. Proxy and permission behavior have separate HTTP integration coverage.
