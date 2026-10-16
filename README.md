# RGSX Library Checker

A single HTML page for [RetroBat](https://www.retrobat.org/) and [Batocera](https://batocera.org/) users that:

- **Shows the ROMs you have installed**, system by system, using the names from your `gamelist.xml` when they exist. The systems list can show all folders, only empty ones, or only those with ROMs.
- **Compares each system with a Top 10, 50, 100, 200 or 500 list** from the source you choose, and shows which missing games are in the [RGSX](https://github.com/RetroGameSets/RGSX) catalogue.
- **Lists top-rated free games from itch.io by genre**: retro homebrew for your systems, plus PC and browser games.
- **Saves its settings** to `rgsx-library-checker.config.json` in the same folder as the page.

It runs locally in Chrome or Edge. Nothing is installed and nothing is uploaded.

## Getting started

1. Download `dist/rgsx-library-checker.html` and put it in your RetroBat folder (for example `C:\RetroBat`) or the Batocera `share` folder.
2. Open it in **Chrome** or **Edge** (Firefox and Safari don't support the folder access the page needs).
3. A getting started page appears the first time. Click **Choose this page's folder…** and pick the folder the page is in. Allow the browser to *view and edit* files.
4. The page finds `roms` and the RGSX database (`saves\ports\rgsx\rgsx.sqlite3`) automatically. If it can't, it asks you to choose them; you can also change them in **Settings**.

Tick **Don't show this again** to skip the getting started page next time (it's still behind the **?** button).

Browsers ask you to re-allow folder access each time the page is opened; that's a browser security rule.

## Top list sources

| Source | What it ranks | Coverage |
| --- | --- | --- |
| **Most notable (Wikidata)** | Games on the platform ordered by how many Wikipedia language editions have an article about them. Open [CC0 data](https://www.wikidata.org/). | Nearly every system; up to 500 games. |
| **Best-selling (Wikipedia)** | The "List of best-selling … video games" article for the platform, in sales order. | ~20 major consoles; 15 to 170 games each. |
| **Critics' all-time best (Wikipedia)** | Wikipedia's "List of video games listed among the best" (games that appear on several critics' all-time lists), filtered to the platform. | Short lists for ~20 systems. |
| **Blended** | The three lists combined with reciprocal-rank fusion. | Wherever any of the above exists. |
| **Custom lists** | Any list you paste or load (TXT, CSV or JSON; one title per line, best first). | You decide. |

A snapshot of every list is built into the page, so it works offline. **Update from the internet** fetches fresh copies from Wikidata and Wikipedia (both allow requests from local pages) and caches them in `rgsx-library-checker-cache/`.

Sources that were considered and left out: IGDB, MobyGames, ScreenScraper and RetroAchievements need personal API keys or block requests from local pages; LaunchBox's database is a large download with no API; Metacritic and GameRankings scores on Wikidata are too sparse for retro systems.

## Free games

The **Free games** tab uses itch.io's public "top rated, free" feeds:

- **Retro homebrew**: games tagged for each system (NES, Game Boy, Mega Drive, ZX Spectrum, PICO-8 and so on), by genre. Games with Windows, macOS, Linux or Android builds are filtered out, because those are usually PC games in a retro style rather than ROMs.
- **PC & browser**: the top 20 free games in each of itch.io's 17 genres.

itch.io doesn't allow other pages to read those feeds, so the data is bundled. To refresh it, run `dist/itch-refresh.js` in the browser console on itch.io (Settings → itch.io data → *Copy refresh script*), then import the `itch-free.json` it downloads.

The tab also links to other free sources: Homebrew Hub, the PICO-8 BBS, TIC-80, WASM-4 and the Romhacking.net homebrew archive.

## How matching works

Titles are compared after removing region and dump tags (`(USA)`, `[!]`), punctuation, "The" and "Version", and turning roman numerals into numbers, so `Legend of Zelda, The - A Link to the Past (USA).sfc` matches *The Legend of Zelda: A Link to the Past*. Names from `gamelist.xml` are used too, which is what makes arcade short names (`sf2.zip`) match. Alternative titles from Wikidata are also tried.

## Reading the RGSX database

RGSX stores its catalogue in `rgsx.sqlite3` in WAL mode, so recent changes live in `rgsx.sqlite3-wal`. The page reads both with [sql.js](https://github.com/sql-js/sql.js) (bundled), replays the committed WAL frames in memory, and never writes to either file. The catalogue is cached in `rgsx-library-checker-cache/` until the database changes.

## Files the page writes

All in the page's own folder:

- `rgsx-library-checker.config.json`: your settings (systems filter, source, Top N size, chosen systems, custom lists, wishlist, folder names).
- `rgsx-library-checker-cache/`: scan results, downloaded lists, the RGSX catalogue index and imported itch.io data.

Both are in `.gitignore`, so personal settings never end up in this repository.

## Building

The page is built from `src/`, `data/` and `vendor/`:

```
python3 build.py
```

This writes `dist/rgsx-library-checker.html` and `dist/itch-refresh.js`.

| Path | Contents |
| --- | --- |
| `src/template.html` | Page layout and styles |
| `src/app.js` | The app |
| `src/sources.js` | Wikidata and Wikipedia list fetchers |
| `data/systems.json` | ROM folder names, labels, Wikipedia platform titles and list pages |
| `data/toplists-snapshot.json` | Bundled copy of every top list |
| `data/itch-free.json`, `data/itch-tags.json` | Bundled itch.io data and the tags used per system |
| `tools/itch-refresh.js` | itch.io refresh script (source) |
| `vendor/` | sql.js 1.10.3 (MIT) |

## Credits and licences

- Code: MIT (see `LICENSE`).
- [sql.js](https://github.com/sql-js/sql.js): MIT.
- Wikidata content: CC0. Wikipedia list titles: CC BY-SA 4.0, from the articles linked above.
- Game titles and links from [itch.io](https://itch.io); each game belongs to its creator.
- Built for use alongside [RGSX](https://github.com/RetroGameSets/RGSX). This page doesn't download games.
