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


# Region / language preference (from rgsx-download-prefs.json or --region/--lang).
REGION_TAGS = {
    "us": ("usa", "us", "ntsc-u", "america"),
    "eu": ("europe", "eu", "pal"),
    "uk": ("uk", "united kingdom", "england", "en-gb"),
    "jp": ("japan", "jp", "jpn", "ntsc-j", "asia"),
    "world": ("world",),
}
LANG_TAGS = {
    "en": ("en",), "fr": ("fr",), "es": ("es", "sp"), "de": ("de", "ge"), "nl": ("nl", "du"),
    "it": ("it",), "pt": ("pt",), "ja": ("ja", "jp", "jpn"), "sv": ("sv", "se"), "da": ("da",),
    "no": ("no",), "fi": ("fi",), "ru": ("ru",), "zh": ("zh", "cn"), "ko": ("ko", "kr"),
}


def _paren_text(name):
    parts = re.findall(r"\(([^)]*)\)|\[([^\]]*)\]", str(name).lower())
    return " ".join(a or b for a, b in parts)


def clean_title(s):
    """Game title with region/language/version tags removed, for matching plain titles."""
    base = nkey(s)
    base = re.sub(r"\([^)]*\)|\[[^\]]*\]|\{[^}]*\}", " ", base)
    return re.sub(r"\s+", " ", base).strip()


def _named_regions(tags):
    return [k for k, ts in REGION_TAGS.items() if k != "world" and any(t in tags for t in ts)]


def _named_langs(tags):
    return [k for k, ts in LANG_TAGS.items() if any(re.search(r"(^|[^a-z])" + t + r"([^a-z]|$)", tags) for t in ts)]


def eligible(name, regions, langs):
    """Allowed by the region/language rules. Untagged and (World) are always allowed."""
    tags = _paren_text(name)
    if regions:
        named = _named_regions(tags)
        is_world = any(t in tags for t in REGION_TAGS["world"])
        if named and not is_world and not any(r in regions for r in named):
            return False
    if langs:
        named = _named_langs(tags)
        if named and not any(l in langs for l in named):
            return False
    return True


def variant_score(name, regions, langs):
    """Higher = better match for the chosen regions, then languages. Ties broken by caller."""
    tags = _paren_text(name)
    score = 0
    if regions and any(r in regions for r in _named_regions(tags)):
        score += 1000
    if langs and any(l in langs for l in _named_langs(tags)):
        score += 100
    # Mild, deterministic default preference so an empty rule still behaves sensibly.
    for i, t in enumerate(("world", "usa", "europe", "en")):
        if t in tags:
            score += (4 - i)
    return score


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


def _best_variant(games, regions, langs):
    """Pick the variant that best matches the rules; tie-break on the tidiest name."""
    return max(games, key=lambda g: (variant_score(g["name"], regions, langs), -len(g["name"])))


def resolve(row, by_folder, regions=(), langs=()):
    """Find the catalogue game for a queue row, enforcing region/language rules. Returns (game, note)."""
    want_folder = str(row.get("platform") or "").strip()
    hints = [h for h in (row.get("name"), row.get("title")) if h]
    if not hints:
        return None, "no title in queue row"

    # A pinned platform stays pinned; a bare title searches the whole catalogue.
    if want_folder and want_folder in by_folder:
        search = [(want_folder, by_folder[want_folder])]
    else:
        search = list(by_folder.items())

    rule = bool(regions) or bool(langs)
    rulestr = "/".join(filter(None, [",".join(regions), ",".join(langs)]))

    def pick(cands):
        # Enforce the rules: keep only versions that match (untagged/World always allowed).
        allowed = [g for g in cands if eligible(g["name"], regions, langs)]
        if rule and not allowed:
            return None, "skipped - no version matches your region/language rules (%s)" % rulestr
        use = allowed or cands
        g = _best_variant(use, regions, langs)
        if len(use) == 1:
            return g, ""
        if rule and variant_score(g["name"], regions, langs) >= 100:
            return g, "%d versions, picked best for %s" % (len(use), rulestr)
        return g, "%d versions, picked 1" % len(use)

    # 1) Exact name as given, or the same title once region/language tags are removed.
    hint_keys = [nkey(h) for h in hints]
    hint_clean = {clean_title(h) for h in hints if clean_title(h)}
    for f, games in search:
        cands = [g for g in games
                 if nkey(g["name"]) in hint_keys or (g["disp"] and nkey(g["disp"]) in hint_keys)
                 or clean_title(g["name"]) in hint_clean or (g["disp"] and clean_title(g["disp"]) in hint_clean)]
        if cands:
            return pick(cands)

    # 2) Loose token match.
    for f, games in search:
        hit = [g for g in games
               if any(qt and all(tok in (set(_tokens(g["name"])) | set(_tokens(g["disp"]))) for tok in qt)
                      for qt in [_tokens(h) for h in hints])]
        if hit:
            allowed = [g for g in hit if eligible(g["name"], regions, langs)]
            if rule and not allowed:
                return None, "skipped - no version matches your region/language rules (%s)" % rulestr
            use = allowed or hit
            if len(use) == 1:
                return use[0], "fuzzy match"
            g = _best_variant(use, regions, langs)
            if rule and variant_score(g["name"], regions, langs) >= 100:
                return g, "fuzzy, picked best for %s" % rulestr
            return None, "ambiguous (%d possible matches) - add it from the catalogue by its exact name" % len(use)

    return None, "not found in the current catalogue - update it in RGSX, then re-export"


KNOWN_COLS = {"type", "platform", "name", "title", "system", "tag", "count", "source", "year"}


def row_key(row):
    """Stable key for a queue/failed row, matching the web page's rgsxKey()."""
    if (row.get("type") or "game").strip().lower() == "itch":
        return "itch|%s|%s" % (str(row.get("system") or "").lower(), str(row.get("tag") or "").lower())
    return "game|%s|%s" % (str(row.get("platform") or "").lower(), str(row.get("name") or row.get("title") or "").lower())


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
    ap.add_argument("--region", help="Region rule(s), comma-separated: uk,eu,us,jp,world (overrides the saved rules)")
    ap.add_argument("--lang", help="Language rule(s), comma-separated: en,fr,es,de,nl,ja,... (overrides the saved rules)")
    ap.add_argument("--retry", action="store_true", help="Also attempt items that failed before (ignore the failed list)")
    ap.add_argument("--retry-system", dest="retry_system", help="Attempt previously-failed items for this system/folder again, e.g. snes")
    args = ap.parse_args(argv)

    root = find_root(args.root)
    rgsx_dir = os.path.join(root, "roms", "ports", "RGSX")
    db_path = os.path.join(root, "saves", "ports", "rgsx", "rgsx.sqlite3")
    cli = os.path.join(rgsx_dir, "rgsx_cli.py")

    # Region / language rules: rgsx-download-prefs.json next to the page, overridden by CLI flags.
    def _as_list(v):
        if isinstance(v, (list, tuple)):
            return [str(x).strip().lower() for x in v if str(x).strip() and str(x).strip().lower() != "any"]
        s = str(v or "").strip().lower()
        return [] if (not s or s == "any") else [p.strip() for p in s.split(",") if p.strip()]

    regions, langs = [], []
    try:
        with open(os.path.join(root, "rgsx-download-prefs.json"), "r", encoding="utf-8-sig") as fh:
            prefs = json.load(fh)
        regions = _as_list(prefs.get("regions", prefs.get("region")))
        langs = _as_list(prefs.get("langs", prefs.get("lang")))
    except Exception:
        pass
    if args.region is not None:
        regions = _as_list(args.region)
    if args.lang is not None:
        langs = _as_list(args.lang)

    log("RGSX batch downloader")
    log("  Folder : %s" % root)
    if regions or langs:
        log("  Rules  : regions=%s languages=%s" % (",".join(regions) or "all", ",".join(langs) or "all"))
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
    try:
        by_folder, downloaded = load_catalogue(db_path)
    except sqlite3.Error as e:
        log("\nCould not read the RGSX catalogue database:\n  %s\n  (%s)" % (db_path, e))
        log("Close RGSX if it is running, make sure the drive/share is reachable, then try again.")
        return 2
    log("  Catalogue: %s games across %s systems\n"
        % (format(sum(len(v) for v in by_folder.values()), ","), len(by_folder)))

    # Previously-failed items (rgsx-download-failed.json) are excluded unless you retry.
    failed_path = os.path.join(root, "rgsx-download-failed.json")
    failed_list = []
    try:
        with open(failed_path, "r", encoding="utf-8-sig") as fh:
            failed_list = json.load(fh) or []
    except Exception:
        failed_list = []
    failed_by_key = {row_key(e): e for e in failed_list if isinstance(e, dict)}
    retry_sys = (args.retry_system or "").strip().lower()

    jobs = []     # {label, cmd, key, row, system}
    skipped = []  # (title, reason)
    for row in queue:
        kind = (row.get("type") or "game").strip().lower()
        key = row_key(row)
        if kind == "itch":
            system = str(row.get("system") or row.get("platform") or "").strip()
            if not system:
                skipped.append(("itch homebrew", "no system given"))
                continue
            if key in failed_by_key and not args.retry and not (retry_sys and retry_sys == system.lower()):
                skipped.append(("Free homebrew: " + system, "previously failed - use Retry"))
                continue
            cmd = [sys.executable, cli, "homebrew", "-s", system, "--install"]
            if str(row.get("tag") or "").strip():
                cmd += ["--tag", str(row["tag"]).strip()]
            if str(row.get("count") or "").strip().isdigit():
                cmd += ["-n", str(row["count"]).strip()]
            label = "Free itch.io homebrew: %s%s" % (system, (" / " + row["tag"]) if row.get("tag") else "")
            jobs.append({"label": label, "cmd": cmd, "key": key, "row": row, "system": system})
            continue
        # game
        title = row.get("title") or row.get("name") or "?"
        system = str(row.get("system") or row.get("platform") or "").strip()
        if key in failed_by_key and not args.retry and not (retry_sys and retry_sys in (system.lower(), str(row.get("platform") or "").lower())):
            skipped.append((title, "previously failed - use Retry to attempt it again"))
            continue
        game, note = resolve(row, by_folder, regions, langs)
        if not game:
            skipped.append((title, note))
            continue
        if (str(game["folder"]).strip().lower(), nkey(game["name"])) in downloaded \
                or (str(game["platform"]).strip().lower(), nkey(game["name"])) in downloaded:
            skipped.append((title, "already downloaded by RGSX"))
            continue
        # Pass the game's actual catalogue platform (a folder can hold several sources, e.g.
        # 'SNES (Archive)' and 'SNES (RomHacks) (Archive)' both live under 'snes').
        label = "%s  ->  %s / %s" % (title, game["platform"], game["name"]) + (("  [%s]" % note) if note else "")
        jobs.append({"label": label, "cmd": [sys.executable, cli, "download", "-p", game["platform"], "-g", game["name"]],
                     "key": key, "row": row, "system": game["folder"]})

    log("Plan: %d to download, %d skipped.\n" % (len(jobs), len(skipped)))
    for j in jobs:
        log("  + " + j["label"])
    for title, reason in skipped:
        log("  - %s  (skip: %s)" % (title, reason))

    if args.dry_run:
        log("\nDry run only - nothing was downloaded.")
        return 0
    if not jobs:
        log("\nNothing to download." + (" (%d previously-failed item(s) were skipped - run with --retry, or use Retry on the page.)" % len(skipped) if skipped else ""))
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
    ok_keys, newly_failed = set(), []
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
            ok_keys.add(j["key"])
        else:
            fail += 1
            rec = dict(j["row"])
            rec["reason"] = "RGSX exit %s" % rc
            rec["system"] = j.get("system") or rec.get("system") or rec.get("platform") or ""
            rec["at"] = datetime.now().isoformat(timespec="seconds")
            newly_failed.append(rec)
        log("   -> %s\n" % status)
        report.append((status, j["label"]))
        time.sleep(1.0)

    # Update the failed list: drop anything that succeeded this run, add/refresh new failures.
    merged = {k: e for k, e in failed_by_key.items() if k not in ok_keys}
    for rec in newly_failed:
        merged[row_key(rec)] = rec
    try:
        if merged:
            with open(failed_path, "w", encoding="utf-8") as fh:
                json.dump(list(merged.values()), fh, indent=2)
        elif os.path.isfile(failed_path):
            os.remove(failed_path)
    except Exception as e:
        log("Could not update the failed list: %s" % e)

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
        log("Report written to %s  (copy its contents if you need to report a problem)" % report_path)
    except Exception as e:
        log("Could not write report: %s" % e)

    # Remove the items that downloaded OK from the queue; keep the rest (failed/skipped) for next time.
    remaining = [r for r in queue if row_key(r) not in ok_keys]
    try:
        if remaining and not (len(remaining) == len(queue) and not ok):
            with open(os.path.join(root, "rgsx-download-queue.json"), "w", encoding="utf-8") as fh:
                json.dump(remaining, fh, indent=2)
        if not remaining and not args.keep:
            for name in ("rgsx-download-queue.json", "rgsx-download-queue.csv"):
                try:
                    os.remove(os.path.join(root, name))
                except OSError:
                    pass
            log("Everything downloaded - list cleared.")
    except Exception as e:
        log("Could not update the download list: %s" % e)

    if fail:
        log("%d item(s) failed and were tagged; they'll be skipped next time unless you Retry (on the page,\n"
            "or run with --retry / --retry-system <system>)." % fail)
    log("\nDone. %d ok, %d failed, %d skipped." % (ok, fail, len(skipped)))
    return 0 if fail == 0 else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except KeyboardInterrupt:
        print("\nCancelled.")
        sys.exit(1)
    except BaseException:
        import platform
        import traceback
        print("\n================ COPY FROM HERE WHEN REPORTING A PROBLEM ================")
        print("RGSX batch downloader - unexpected error")
        print("When     : " + datetime.now().isoformat(timespec="seconds"))
        print("Python   : " + sys.version.replace("\n", " "))
        print("Platform : " + platform.platform())
        print("Executable: " + sys.executable)
        print("Argv     : " + " ".join(sys.argv))
        print("CWD      : " + os.getcwd())
        print("-" * 72)
        print(traceback.format_exc())
        print("================ COPY TO HERE ================")
        try:
            input("\nPress Enter to close. ")
        except Exception:
            pass
        sys.exit(1)
