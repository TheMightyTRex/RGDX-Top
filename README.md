# RGSX Library Checker

A single HTML page for [RetroBat](https://www.retrobat.org/) and [Batocera](https://batocera.org/) users that:

- **Shows the ROMs you have installed**, system by system, using the names from your `gamelist.xml` when they exist. The systems list can show all folders, only empty ones, or only those with ROMs.
- **Compares each system with a Top 10, 50, 100, 200 or 500 list** from the source you choose, and shows which missing games are in the [RGSX](https://github.com/RetroGameSets/RGSX) catalogue.
- **Imports top lists from websites** for each system (Lemon Amiga, Lemon64, Spectrum Computing, Atarimania, MobyGames and more).
- **Uses API sources** (RetroAchievements, RAWG) with your own keys, stored encrypted.
- **Lists top-rated free games from itch.io by genre**: retro homebrew for your systems, plus PC and browser games.
- **Saves its settings** to `rgsx-library-checker.config.json` in the same folder as the page.

It runs locally in Chrome or Edge. Nothing is installed and nothing is uploaded.

## Download

**[Download RGSX-Library-Checker.zip](dist/RGSX-Library-Checker.zip)** (on GitHub, open the file and click *Download raw file*).

It contains everything needed to run:

```
RGSX Library Checker/
  rgsx-library-checker.html   the app: copy this into your RetroBat folder
  START HERE.txt              three-step instructions
  extras/list-grabber.js      optional: import lists from websites
  extras/itch-refresh.js      optional: refresh the itch.io data
```

## Getting started

1. Copy `rgsx-library-checker.html` into your RetroBat folder (for example `C:\RetroBat`) or the Batocera `share` folder.
2. Open it in **Chrome** or **Edge** (Firefox and Safari don't support the folder access the page needs).
3. A getting started page appears the first time. Click **Choose this page's folder…** and pick the folder the page is in. Allow the browser to *view and edit* files.
4. The page finds `roms` and the RGSX database (`saves\ports\rgsx\rgsx.sqlite3`) automatically. If it can't, it asks you to choose them; you can also change them in **Settings › Folders**.

Tick **Don't show this again** to skip the getting started page next time. The **Help** tab in the page explains everything else.

Browsers ask you to re-allow folder access each time the page is opened; that's a browser security rule.

## Top list sources

### Built in (bundled, and updatable from the internet)

| Source | What it ranks | Coverage |
| --- | --- | --- |
| **Most notable (Wikidata)** | Games on the platform by how many Wikipedia language editions cover them. [CC0 data](https://www.wikidata.org/). | ~66 systems, up to 500 games. |
| **Most read on Wikipedia (12 months)** | The same games by English Wikipedia page views over the last 12 full months ([Wikimedia pageviews API](https://wikimedia.org/api/rest_v1/)). | Same systems. |
| **Notable exclusives (Wikidata)** | "Most notable", limited to games whose only listed platform is this one, so multi-platform hits don't crowd the list. | Same systems; shorter lists. |
| **Review scores (Wikidata)** | Review scores recorded for this platform's version (Metacritic, GameRankings, magazines), averaged with a Bayesian average. | Strong for 16-bit computers (800+ Amiga games), thin for some consoles. |
| **Best-selling (Wikipedia)** | The "List of best-selling … video games" article for the platform, in sales order. | ~23 major consoles. |
| **Critics' all-time best (Wikipedia)** | Wikipedia's "List of video games listed among the best", filtered to the platform. | Short lists for ~30 systems. |
| **Blended** | All the lists above combined with reciprocal-rank fusion. | Wherever any of them exists. |

A snapshot of every built-in list is in the page, so it works offline. **Update from the internet** fetches fresh copies (these services allow requests from local pages) and caches them in `rgsx-library-checker-cache/`.

### With an API key (Settings › API keys)

| Source | What it ranks | Notes |
| --- | --- | --- |
| **Most played (RetroAchievements)** | Players per game on [RetroAchievements](https://retroachievements.org/). | Free [web API key](https://retroachievements.org/settings). Checks the games in the built-in lists one request at a time, so a few minutes per system; cached. |
| **User rating / Metacritic / Most added (RAWG)** | [RAWG](https://rawg.io/apidocs) user ratings, Metacritic scores and collection counts. | Free API key. |

IGDB, MobyGames, TheGamesDB and Giant Bomb block requests from pages opened from disk, and ScreenScraper needs developer credentials, so they aren't API sources. Their websites can still be used as website lists.

### From websites (Settings › a system)

Each system's settings page suggests sites with a top list for it, and you can add any other page:

| System | Suggested sites |
| --- | --- |
| Amiga | Lemon Amiga (overall and by genre), Hall of Light |
| Commodore 64 | Lemon64, C64-Wiki Top 100 and most voted |
| ZX Spectrum | Spectrum Computing ratings, Time Extension |
| Amstrad CPC | Time Extension, CPC-Power |
| MSX | Generation MSX highest rated and most popular |
| Atari ST, 8-bit, 2600, 5200, Jaguar | Atarimania top lists by rating, downloads and views |
| BBC Micro | Complete BBC Micro Games Archive |
| Nintendo systems | Nintendo Life best-of guides and reader ratings |
| Sega systems | Time Extension best-of guides |
| PlayStation, PS2, PSP | Push Square best-of guides and reader ratings |
| PICO-8 | PICO-8 BBS featured carts |
| Every system | MobyGames (by Moby score) and RetroAchievements (by players) |

Most of these sites don't allow other pages to read them, and some have bot checks, so the page includes a **list grabber**: a bookmarklet (or console script) you click on the list page in your own browser. It finds the ranked list (or uses the text you selected) and copies it; paste it into the page, check the preview, save. The list then appears as a source on the Top lists page for that system. You can also load a page saved with Ctrl+S, or paste plain text.

The suggested sites are in `data/site-lists.json`; pull requests with more are welcome.

## API keys and encryption

- Keys are encrypted with **AES-256-GCM** (WebCrypto) before they're written to the config file, and only decrypted in memory.
- **This browser** mode (default): the AES key is a non-extractable WebCrypto key kept in the browser's IndexedDB. Someone with a copy of the config file can't decrypt the keys.
- **Passphrase** mode: the AES key is derived from your passphrase with PBKDF2-SHA256, 310,000 rounds. Only a salt and a check value are stored. You unlock once per visit, on any computer.
- Each key is only sent to its own service, as that service's API requires.

## Free games

The **Free games** tab uses itch.io's public "top rated, free" feeds:

- **Retro homebrew**: games tagged for each system (NES, Game Boy, Mega Drive, ZX Spectrum, PICO-8 and so on), by genre. Games with Windows, macOS, Linux or Android builds are filtered out, because those are usually PC games in a retro style rather than ROMs.
- **PC & browser**: the top 20 free games in each of itch.io's 17 genres.

itch.io doesn't allow other pages to read those feeds, so the data is bundled. To refresh it, run `extras/itch-refresh.js` in the browser console on itch.io (Settings › itch.io data › *Copy refresh script*), then import the `itch-free.json` it downloads.

## How matching works

Titles are compared after removing region and dump tags (`(USA)`, `[!]`), punctuation, "The" and "Version", and turning roman numerals into numbers, so `Legend of Zelda, The - A Link to the Past (USA).sfc` matches *The Legend of Zelda: A Link to the Past*. Names from `gamelist.xml` are used too, which is what makes arcade short names (`sf2.zip`) match. Alternative titles from Wikidata are also tried.

## Reading the RGSX database

RGSX stores its catalogue in `rgsx.sqlite3` in WAL mode, so recent changes live in `rgsx.sqlite3-wal`. The page reads both with [sql.js](https://github.com/sql-js/sql.js) (bundled), replays the committed WAL frames in memory, and never writes to either file. The catalogue is cached in `rgsx-library-checker-cache/` until the database changes.

## Files the page writes

All in the page's own folder:

- `rgsx-library-checker.config.json`: your settings, website lists, wishlist and encrypted API keys.
- `rgsx-library-checker-cache/`: scan results, downloaded lists, the RGSX catalogue index and imported itch.io data.

Both are in `.gitignore`, so personal settings never end up in this repository.

## Building

```
python3 build.py
```

This writes `dist/rgsx-library-checker.html`, `dist/list-grabber.js`, `dist/itch-refresh.js` and the download `dist/RGSX-Library-Checker.zip`.

| Path | Contents |
| --- | --- |
| `src/template.html` | Page layout and styles |
| `src/app.js` | The app |
| `src/sources.js` | Wikidata, Wikipedia and Wikimedia list fetchers |
| `src/extract.js` | Finds a ranked list on a web page (used by the app and the grabber) |
| `src/START-HERE.txt` | Instructions in the download zip |
| `data/systems.json` | ROM folders, labels, Wikipedia platform titles, list pages, RetroAchievements, MobyGames and RAWG platform IDs |
| `data/site-lists.json` | Suggested websites with top lists, per system |
| `data/toplists-snapshot.json` | Bundled copy of every built-in list |
| `data/itch-free.json`, `data/itch-tags.json` | Bundled itch.io data and the tags used per system |
| `tools/list-grabber.js`, `tools/itch-refresh.js` | Browser scripts (sources) |
| `vendor/` | sql.js 1.10.3 (MIT) |

Tests: `cd test && npm install && npm test` (Playwright, headless Chromium).

## Credits and licences

- Code: MIT (see `LICENSE`).
- [sql.js](https://github.com/sql-js/sql.js): MIT.
- Wikidata content: CC0. Wikipedia list titles and page-view counts: CC BY-SA 4.0 / CC0, from Wikipedia and Wikimedia.
- Game titles and links from [itch.io](https://itch.io); each game belongs to its creator.
- Website lists belong to their sites; the page only stores the titles you import, for your own checklist.
- Built for use alongside [RGSX](https://github.com/RetroGameSets/RGSX). This page doesn't download games.
