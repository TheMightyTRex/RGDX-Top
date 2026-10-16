#!/usr/bin/env python3
"""Builds dist/rgsx-library-checker.html: one self-contained file with sql.js, the data snapshots and the app."""
import base64
import html
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent
VERSION = (ROOT / "VERSION").read_text().strip()


def js(obj):
    # JSON is valid JavaScript; escape "</" so nothing can close the surrounding <script> tag.
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")


def load(name):
    return json.loads((ROOT / "data" / name).read_text(encoding="utf-8"))


itch = load("itch-free.json")
for g in itch["games"]:
    g[0] = html.unescape(g[0])
    if len(g) > 3:
        g[3] = html.unescape(g[3])

itch_tags = load("itch-tags.json")
itch_script = (ROOT / "tools" / "itch-refresh.js").read_text(encoding="utf-8").replace("/*__ITCH_TAGS__*/{}", js(itch_tags))
(ROOT / "dist").mkdir(exist_ok=True)
(ROOT / "dist" / "itch-refresh.js").write_text(itch_script, encoding="utf-8")

sqljs = (ROOT / "vendor" / "sql-wasm.js").read_text(encoding="utf-8")
assert "</script" not in sqljs.lower()
wasm = base64.b64encode((ROOT / "vendor" / "sql-wasm.wasm").read_bytes()).decode()

out = (ROOT / "src" / "template.html").read_text(encoding="utf-8")
parts = {
    "/*__SQLJS__*/": sqljs,
    "/*__SOURCES__*/": (ROOT / "src" / "sources.js").read_text(encoding="utf-8"),
    "/*__SYSTEMS__*/{}": js(load("systems.json")),
    "/*__SNAPSHOT__*/{}": js(load("toplists-snapshot.json")),
    "/*__ITCH__*/null": js(itch),
    "/*__ITCH_TAGS__*/{}": js(itch_tags),
    "/*__ITCH_SCRIPT__*/''": js(itch_script),
    "/*__WASM__*/": wasm,
    "/*__VERSION__*/": VERSION,
    "/*__APP__*/": (ROOT / "src" / "app.js").read_text(encoding="utf-8"),
}
for key, value in parts.items():
    assert key in out, key
    out = out.replace(key, value, 1)

target = ROOT / "dist" / "rgsx-library-checker.html"
target.write_text(out, encoding="utf-8")
print(f"wrote {target} ({target.stat().st_size / 1e6:.2f} MB)")
