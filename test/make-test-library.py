#!/usr/bin/env python3
"""Generates a random RetroBat-style folder for testing RGSX Library Checker without a real install.

    python3 make-test-library.py [OUTPUT_DIR] [--seed N] [--systems nes,snes,...] [--games N]

Creates OUTPUT_DIR (default: test/fixtures/random-retrobat) with:
  roms/<system>/...                 empty "ROM" files named like real dumps, picked at random from the bundled top lists,
                                    with region tags, revisions, subfolders, multi-disc sets and media folders to ignore
  roms/<system>/gamelist.xml        for about half the systems, with proper names (and arcade-style short file names)
  saves/ports/rgsx/rgsx.sqlite3     an RGSX-style catalogue in WAL mode, with recent rows left in rgsx.sqlite3-wal
  expected.json                     what the page should find: file counts per system and which games are installed

Everything is random but repeatable for a given seed. The ROM files contain only a few bytes.
"""
import argparse
import json
import os
import pathlib
import random
import shutil
import sqlite3
import unicodedata

ROOT = pathlib.Path(__file__).resolve().parent.parent
EXT = {"nes": ".nes", "snes": ".sfc", "megadrive": ".md", "gb": ".gb", "gbc": ".gbc", "gba": ".gba", "n64": ".z64",
       "mastersystem": ".sms", "gamegear": ".gg", "pcengine": ".pce", "atari2600": ".a26", "psx": ".chd", "amiga500": ".adf",
       "c64": ".d64", "zxspectrum": ".tzx", "mame": ".zip", "dreamcast": ".chd", "saturn": ".chd", "nds": ".nds"}
REGIONS = ["(USA)", "(Europe)", "(Japan)", "(World)", "(USA, Europe)", "(Japan, USA)", "(Europe) (En,Fr,De)"]
EXTRAS = ["", "", "", " (Rev 1)", " (Rev A)", " [!]", " (Beta)", " (Proto)"]
JUNK = ["readme.txt", "info.nfo", "_info.txt", "Thumbs.db", "desktop.ini"]
MEDIA = ["images", "videos", "manuals"]


def ascii_name(s):
    # File names stay ASCII: the browser's private test storage (OPFS) rejects accented names, while real folders
    # opened with the folder picker don't. Accented titles are still tested through gamelist.xml.
    return unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()


def dump_name(title, rng):
    t = ascii_name(title).replace(":", " -").replace("/", "-").replace("?", "").replace('"', "")
    if t.startswith("The ") and rng.random() < 0.5:   # No-Intro style "Legend of Zelda, The"
        t = t[4:] + ", The"
    return f"{t} {rng.choice(REGIONS)}{rng.choice(EXTRAS)}".strip()


def short_name(title):
    words = [w for w in "".join(c if c.isalnum() else " " for c in ascii_name(title).lower()).split() if w not in ("the", "of", "and")]
    return (words[0][:5] + "".join(w[0] for w in words[1:]))[:8] or "game"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("out", nargs="?", default=str(ROOT / "test" / "fixtures" / "random-retrobat"))
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--systems", default="nes,snes,megadrive,gb,gba,n64,psx,amiga500,c64,zxspectrum,mame,atari2600")
    ap.add_argument("--games", type=int, default=60, help="average installed games per system")
    ap.add_argument("--layout", choices=["retrobat", "batocera"], default="retrobat", help="RetroBat folder or Batocera share")
    a = ap.parse_args()
    rng = random.Random(a.seed)
    snap = json.loads((ROOT / "data" / "toplists-snapshot.json").read_text(encoding="utf-8"))
    out = pathlib.Path(a.out)
    if out.exists():
        shutil.rmtree(out)
    (out / "roms").mkdir(parents=True)
    expected = {"seed": a.seed, "layout": a.layout, "systems": {}}
    # Markers the page uses to recognise the installation, and the RGSX app folder.
    if a.layout == "retrobat":
        (out / "retrobat.ini").write_text("[RetroBat]\n", encoding="utf-8")
        (out / "emulationstation").mkdir()
    else:
        for d in ("bios", "system", "screenshots"):
            (out / d).mkdir()
        (out / "system" / "batocera.conf").write_text("system.hostname=BATOCERA\n", encoding="utf-8")
    years = {}
    for src in ("wikidata", "pageviews", "exclusives", "sales", "critics"):
        for k, lst in snap.get(src, {}).items():
            for e in lst:
                if e.get("y"):
                    years.setdefault((k, e["t"]), e["y"])
    catalog = {}

    for sys_key in [s.strip() for s in a.systems.split(",") if s.strip()]:
        pool = []
        for src in ("wikidata", "pageviews", "exclusives", "sales", "critics"):
            pool += [e["t"] for e in snap.get(src, {}).get(sys_key, [])]
        pool = list(dict.fromkeys(pool)) or [f"Test Game {i}" for i in range(200)]
        d = out / "roms" / sys_key
        d.mkdir()
        n = max(0, min(len(pool), int(rng.gauss(a.games, a.games / 3))))
        installed = rng.sample(pool, n)
        ext = EXT.get(sys_key, ".bin")
        files, gamelist = [], []
        arcade = sys_key == "mame"
        for title in installed:
            sub = rng.choice(["", "", "", "", "USA", "Europe", "Favourites/Platform"]) if not arcade else ""
            fname = (short_name(title) + ext) if arcade else (dump_name(title, rng) + ext)
            p = d / sub / fname if sub else d / fname
            p.parent.mkdir(parents=True, exist_ok=True)
            if p.exists():
                continue
            p.write_bytes(b"ROM")
            rel = (sub + "/" if sub else "") + fname
            files.append(rel)
            ra = rng.randint(1, 30000) if rng.random() < 0.4 else None
            y = years.get((sys_key, title))
            gamelist.append((rel, title, y and y + rng.choice([0, 0, 0, 1]), ra))
            if ext == ".chd" and rng.random() < 0.15:          # a two-disc game: second disc file
                p2 = p.with_name(p.stem + " (Disc 2)" + ext)
                p2.write_bytes(b"ROM")
                files.append(rel.replace(fname, p2.name))
        for m in MEDIA:                                       # media folders the page must ignore
            if rng.random() < 0.7:
                (d / m).mkdir(exist_ok=True)
                for rel, *_ in gamelist[: rng.randint(0, 5)]:
                    (d / m / (pathlib.Path(rel).stem + "-image.png")).write_bytes(b"PNG")
        for j in rng.sample(JUNK, 2):
            (d / j).write_bytes(b"x")
        use_gamelist = arcade or rng.random() < 0.5
        if use_gamelist:
            xml = ["<?xml version='1.0' encoding='utf-8'?>", "<gameList>"]
            esc = lambda s: s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            for rel, title, y, ra in gamelist:
                xml += ["  <game>", f"    <path>./{esc(rel)}</path>", f"    <name>{esc(title)}</name>"]
                if y:
                    xml.append(f"    <releasedate>{y}0101T000000</releasedate>")
                if ra:
                    xml.append(f"    <cheevosId>{ra}</cheevosId>")
                xml.append("  </game>")
            xml.append("</gameList>")
            (d / "gamelist.xml").write_text("\n".join(xml), encoding="utf-8")
        missing = [t for t in pool if t not in installed]
        in_rgsx = rng.sample(missing, min(len(missing), max(1, len(missing) // 3)))
        catalog[sys_key] = [dump_name(t, rng) for t in in_rgsx] + [f"Obscure Homebrew {i} (World) (Unl)" for i in range(rng.randint(20, 80))]
        expected["systems"][sys_key] = {"files": len(files), "installed": installed, "gamelist": use_gamelist, "in_rgsx_not_installed": in_rgsx,
                                        "meta": [{"t": t, "y": y, "ra": ra} for _, t, y, ra in gamelist] if use_gamelist else []}

    # Empty system folders, to test "Show empty"
    for empty in ("3do", "vectrex"):
        (out / "roms" / empty).mkdir()
        expected["systems"][empty] = {"files": 0, "installed": [], "gamelist": False, "in_rgsx_not_installed": []}

    (out / "roms" / "ports" / "RGSX").mkdir(parents=True)
    (out / "roms" / "ports" / "RGSX" / "__main__.py").write_text("# RGSX placeholder\n", encoding="utf-8")
    # RGSX-style catalogue. Half the games are committed to the main file, the rest stay in the WAL.
    rg = out / "saves" / "ports" / "rgsx"
    rg.mkdir(parents=True)
    db = rg / "rgsx.sqlite3"
    c = sqlite3.connect(db)
    c.execute("pragma journal_mode=wal")
    c.execute("pragma wal_autocheckpoint=0")
    c.executescript("""CREATE TABLE schema_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE platforms(id INTEGER PRIMARY KEY, platform_name TEXT NOT NULL UNIQUE, folder TEXT NOT NULL DEFAULT '');
      CREATE TABLE games(id INTEGER PRIMARY KEY, platform_id INTEGER NOT NULL, name TEXT NOT NULL, display_name TEXT NOT NULL DEFAULT '');""")
    c.execute("insert into schema_meta values('catalog_sync_sequence', ?)", (str(rng.randint(1000, 99999)),))
    rows = []
    for i, (sys_key, names) in enumerate(catalog.items(), start=1):
        c.execute("insert into platforms values(?,?,?)", (i, f"{sys_key.upper()} (Archive)", sys_key))
        rows += [(i, f"{sys_key.upper()}/{n}.zip") for n in names]
    c.execute("insert into platforms values(?,?,?)", (len(catalog) + 1, "- BIOS -", "bios"))
    rng.shuffle(rows)
    half = len(rows) // 2
    c.executemany("insert into games(platform_id, name) values(?,?)", rows[:half])
    c.commit()
    c.execute("pragma wal_checkpoint(TRUNCATE)")
    c.executemany("insert into games(platform_id, name) values(?,?)", rows[half:])
    c.commit()
    # Copy the files while the connection is open, so the WAL isn't merged on close.
    tmp = rg / "tmp"
    tmp.mkdir()
    for suffix in ("", "-wal"):
        shutil.copy(str(db) + suffix, tmp / ("rgsx.sqlite3" + suffix))
    c.close()
    for suffix in ("", "-wal", "-shm"):
        if os.path.exists(str(db) + suffix):
            os.remove(str(db) + suffix)
    for f in tmp.iterdir():
        shutil.move(str(f), rg / f.name)
    tmp.rmdir()
    expected["rgsx_games"] = len(rows)
    (out / "expected.json").write_text(json.dumps(expected, indent=1, ensure_ascii=False), encoding="utf-8")
    total = sum(s["files"] for s in expected["systems"].values())
    print(f"{out}: {len(expected['systems'])} system folders, {total} ROM files, {len(rows)} RGSX catalogue games (seed {a.seed})")


if __name__ == "__main__":
    main()
