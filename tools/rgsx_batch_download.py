#!/usr/bin/env python3
"""
RGSX batch downloader
=====================

Reads a download queue produced by the RGSX Library Checker ("Send to RGSX"
and "Add" buttons) and downloads each item through the official RGSX
command-line tool (roms/ports/RGSX/rgsx_cli.py).

The queue can hold two kinds of item:
  * game  - a specific catalogue game: {platform, name, title}
  * itch  - free itch.io homebrew for a system: {type:"itch", system, tag, count}

This file lives in your RetroBat / Batocera / Knulli folder, next to
rgsx-library-checker.html. Launch it with "Download with RGSX.bat" (Windows)
or "RGSX-download.sh" (Linux / macOS / Batocera / Knulli), or run directly:

    python rgsx_batch_download.py [options]

Options:
    --list FILE    Queue file. Default: rgsx-download-queue.json, or .csv,
                   next to this script.
    --dry-run      Resolve/plan everything and show it, without downloading.
    --yes          Don't ask for confirmation before downloading.
    --limit N      Only process the first N queued items.
    --keep         Don't delete the queue file after a successful run.
    --root DIR     RetroBat/Batocera root (auto-detected by default).

Nothing is uploaded; it only reads the RGSX catalogue and calls RGSX to
download. It never deletes your existing ROMs.
"""
import argparse
import csv
import json
import os
import re
import sqlite3
import subprocess
import sys
import time
from datetime import datetime


def log(*a):
    print(*a, flush=True)


def find_root(explicit):
    if explicit:
        return os.path.abspath(explicit)
    here = os.path.dirname(os.path.abspath(__file__))
    d = here
    for _ in range(8):
        if os.path.isdir(os.path.join(d, "roms", "ports", "RGSX")):
            return d
        parent = os.path.dirname(d)
        if parent == d:
            break
        d = parent
    return here


# -------------------------------------------------------------- name matching
def _basename(s):
    return str(s).replace("\\", "/").split("/")[-1]


def _strip_ext(s):
    return os.path.splitext(s)[0]


def nkey(s):
    """Loose comparison key: basename, no extension, lower-case, trimmed."""
    return _strip_ext(_basename(str(s or ""))).strip().lower()


def _tokens(s):
    return re.findall(r"[a-z0-9]+", str(s or "").lower())


def load_catalogue(db_path):
    uri = "file:{}?mode=ro".format(db_path.replace("?", "%3f"))
    con = sqlite3.connect(uri, uri=True)
    try:
        by_folder = {}
        for folder, pname, name, disp, url in con.execute(
                "SELECT p.folder, p.platform_name, g.name, g.display_name, g.url "
                "FROM games g JOIN platforms p ON p.id = g.platform_id "
                "WHERE p.folder <> '' AND p.folder <> 'bios'"):
            by_folder.setdefault(folder, []).append(
                {"name": name, "disp": disp or "", "url": url or "",
                 "folder": folder, "platform": pname or folder})
        downloaded = set()
        try:
            for plat, gname in con.execute("SELECT platform, game_name FROM downloaded_games"):
                downloaded.add((str(plat or "").strip().lower(), nkey(gname)))
        except Exception:
            pass
        return by_folder, downloaded
    finally:
        con.close()


def resolve(row, by_folder):
    """Find the exact catalogue game for a queue row. Returns (game, note)."""
    want_folder = str(row.get("platform") or "").strip()
    hints = [h for h in (row.get("name"), row.get("title")) if h]
    if not hints:
        return None, "no title in queue row"

    search = []
    if want_folder and want_folder in by_folder:
        search.append((want_folder, by_folder[want_folder]))
    for f, games in by_folder.items():
        if f != want_folder:
            search.append((f, games))

    hint_keys = [nkey(h) for h in hints]
    for f, games in search:
        exact = [g for g in games
                 if nkey(g["name"]) in hint_keys or (g["disp"] and nkey(g["disp"]) in hint_keys)]
        if exact:
            exact.sort(key=lambda g: len(g["name"]))
            note = "" if len(exact) == 1 else "%d catalogue entries, picked 1" % len(exact)
            return exact[0], note

    for f, games in search:
        hit = []
        for g in games:
            gt = set(_tokens(g["name"])) | set(_tokens(g["disp"]))
            if any(qt and all(tok in gt for tok in qt) for qt in [_tokens(h) for h in hints]):
                hit.append(g)
        if len(hit) == 1:
            return hit[0], "fuzzy match"
        if len(hit) > 1:
            return None, "ambiguous (%d possible matches) - add it from the catalogue by its exact name" % len(hit)

    return None, "not found in the current catalogue - update it in RGSX, then re-export"


KNOWN_COLS = {"type", "platform", "name", "title", "system", "tag", "count", "source", "year"}


def read_queue(path):
    import io
    text = open(path, "r", encoding="utf-8-sig").read()
    low = path.lower()
    if low.endswith(".json") or text.lstrip()[:1] in "[{":
        data = json.loads(text)
        return [dict(r) for r in data] if isinstance(data, list) else []
    # CSV with a header the Library Checker wrote.
    first = next((ln for ln in text.splitlines() if ln.strip()), "")
    header = [c.strip().lower() for c in next(csv.reader([first]), [])]
    if low.endswith(".csv") and header and (set(header) & KNOWN_COLS):
        return [{k: (v or "").strip() for k, v in r.items()} for r in csv.DictReader(io.StringIO(text))]
    # A plain list you keep by hand: one item per line.
    #   title                      (platform searched across the whole catalogue)
    #   system <TAB> title   or   system | title     (pin it to a platform/folder)
    # Lines starting with # are comments. Commas are left alone (titles contain them).
    rows = []
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        plat, title = "", line
        for sep in ("\t", " | ", "|"):
            if sep in line:
                a, b = line.split(sep, 1)
                plat, title = a.strip(), b.strip()
                break
        title = re.sub(r"^\s*\d+[.)]\s+", "", title).strip()
        if title:
            rows.append({"type": "game", "platform": plat, "name": title, "title": title, "source": "list"})
    return rows


def pick_queue(root, explicit):
    if explicit:
        return explicit if os.path.isfile(explicit) else None
    for name in ("rgsx-download-queue.json", "rgsx-download-queue.csv", "rgsx-download-list.txt"):
        p = os.path.join(root, name)
        if os.path.isfile(p):
            return p
    return None


def main(argv=None):
    ap = argparse.ArgumentParser(description="Download a queue of games through RGSX.")
    ap.add_argument("--list", dest="list_path")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--yes", "-y", action="store_true")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--keep", action="store_true")
    ap.add_argument("--root")
    args = ap.parse_args(argv)

    root = find_root(args.root)
    rgsx_dir = os.path.join(root, "roms", "ports", "RGSX")
    db_path = os.path.join(root, "saves", "ports", "rgsx", "rgsx.sqlite3")
    cli = os.path.join(rgsx_dir, "rgsx_cli.py")

    log("RGSX batch downloader")
    log("  Folder : %s" % root)
    if not os.path.isfile(cli):
        log("\nCould not find RGSX at:\n  %s\nStart RGSX once in RetroBat (Ports), then try again." % cli)
        return 2
    if not os.path.isfile(db_path):
        log("\nThe RGSX catalogue database is missing:\n  %s\nStart RGSX once so it downloads its catalogue, then try again." % db_path)
        return 2

    queue_path = pick_queue(root, args.list_path)
    if not queue_path:
        log("\nNo download list found. In the RGSX Library Checker, add some games with\n"
            "\"Send to RGSX\" (Top lists) or \"Add\" (the RGSX tab), then run this again.")
        return 2
    log("  List   : %s" % queue_path)
    try:
        queue = read_queue(queue_path)
    except Exception as e:
        log("\nCould not read the list (%s): %s" % (queue_path, e))
        return 2
    if args.limit > 0:
        queue = queue[: args.limit]
    if not queue:
        log("\nThe download list is empty.")
        return 0

    log("  Catalogue: reading %s ..." % os.path.basename(db_path))
    by_folder, downloaded = load_catalogue(db_path)
    log("  Catalogue: %s games across %s systems\n"
        % (format(sum(len(v) for v in by_folder.values()), ","), len(by_folder)))

    jobs = []     # {label, cmd}
    skipped = []  # (label, reason)
    for row in queue:
        kind = (row.get("type") or "game").strip().lower()
        if kind == "itch":
            system = str(row.get("system") or row.get("platform") or "").strip()
            if not system:
                skipped.append(("itch homebrew", "no system given"))
                continue
            cmd = [sys.executable, cli, "homebrew", "-s", system, "--install"]
            if str(row.get("tag") or "").strip():
                cmd += ["--tag", str(row["tag"]).strip()]
            if str(row.get("count") or "").strip().isdigit():
                cmd += ["-n", str(row["count"]).strip()]
            label = "Free itch.io homebrew: %s%s" % (system, (" / " + row["tag"]) if row.get("tag") else "")
            jobs.append({"label": label, "cmd": cmd})
            continue
        # game
        game, note = resolve(row, by_folder)
        title = row.get("title") or row.get("name") or "?"
        if not game:
            skipped.append((title, note))
            continue
        if (str(game["folder"]).strip().lower(), nkey(game["name"])) in downloaded \
                or (str(game["platform"]).strip().lower(), nkey(game["name"])) in downloaded:
            skipped.append((title, "already downloaded by RGSX"))
            continue
        label = "%s  ->  %s / %s" % (title, game["folder"], game["name"]) + (("  [%s]" % note) if note else "")
        jobs.append({"label": label, "cmd": [sys.executable, cli, "download", "-p", game["folder"], "-g", game["name"]]})

    log("Plan: %d to download, %d skipped.\n" % (len(jobs), len(skipped)))
    for j in jobs:
        log("  + " + j["label"])
    for title, reason in skipped:
        log("  - %s  (skip: %s)" % (title, reason))

    if args.dry_run:
        log("\nDry run only - nothing was downloaded.")
        return 0
    if not jobs:
        log("\nNothing to download.")
        return 0

    if not args.yes:
        log("")
        try:
            ans = input("Download the %d item(s) above with RGSX? [y/N] " % len(jobs)).strip().lower()
        except EOFError:
            ans = ""
        if ans not in ("y", "yes"):
            log("Cancelled. Nothing downloaded.")
            return 1

    env = dict(os.environ)
    env["RGSX_HEADLESS"] = "1"
    report = []
    ok = fail = 0
    log("")
    for i, j in enumerate(jobs, 1):
        log("[%d/%d] %s" % (i, len(jobs), j["label"]))
        try:
            rc = subprocess.call(j["cmd"], cwd=rgsx_dir, env=env)
        except Exception as e:
            rc = -1
            log("   error launching RGSX: %s" % e)
        status = "OK" if rc == 0 else "FAILED (exit %s)" % rc
        if rc == 0:
            ok += 1
        else:
            fail += 1
        log("   -> %s\n" % status)
        report.append((status, j["label"]))
        time.sleep(1.0)

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    report_path = os.path.join(root, "rgsx-download-report-%s.txt" % stamp)
    try:
        with open(report_path, "w", encoding="utf-8") as fh:
            fh.write("RGSX batch download report - %s\n" % datetime.now().isoformat(timespec="seconds"))
            fh.write("Queue: %s\n\n" % queue_path)
            fh.write("OK: %d   Failed: %d   Skipped: %d\n\n" % (ok, fail, len(skipped)))
            for status, label in report:
                fh.write("[%s] %s\n" % (status, label))
            if skipped:
                fh.write("\nSkipped:\n")
                for title, reason in skipped:
                    fh.write("  %s  (%s)\n" % (title, reason))
        log("Report written to %s" % report_path)
    except Exception as e:
        log("Could not write report: %s" % e)

    if fail == 0 and not args.keep:
        for name in ("rgsx-download-queue.json", "rgsx-download-queue.csv"):
            try:
                os.remove(os.path.join(root, name))
            except OSError:
                pass
        log("Download list cleared.")
    elif fail:
        log("Some items failed, so the list was kept. Fix the issue and run again\n"
            "(anything already downloaded is skipped), or clear it in the Library Checker.")

    log("\nDone. %d ok, %d failed, %d skipped." % (ok, fail, len(skipped)))
    return 0 if fail == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
