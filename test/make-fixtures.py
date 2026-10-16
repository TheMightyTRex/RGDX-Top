#!/usr/bin/env python3
"""Creates a small RGSX-style SQLite database in WAL mode with uncheckpointed rows, for the browser tests."""
import os, pathlib, shutil, sqlite3
d = pathlib.Path(__file__).parent / "fixtures"; d.mkdir(exist_ok=True)
p = d / "rgsx.sqlite3"
for x in ("", "-wal", "-shm"):
    if os.path.exists(str(p) + x): os.remove(str(p) + x)
c = sqlite3.connect(p); c.execute("pragma journal_mode=wal"); c.execute("pragma wal_autocheckpoint=0")
c.executescript("""CREATE TABLE platforms(id INTEGER PRIMARY KEY, platform_name TEXT, folder TEXT);
CREATE TABLE games(id INTEGER PRIMARY KEY, platform_id INT, name TEXT, display_name TEXT DEFAULT '');""")
c.execute("insert into platforms values(1,'NES (Archive)','nes')"); c.commit()
c.execute("pragma wal_checkpoint(TRUNCATE)")
for i in range(3000): c.execute("insert into games(platform_id,name) values(1,?)", (f"Nintendo - NES/Game {i} (USA).zip",))
c.execute("insert into platforms values(2,'SNES (Archive)','snes')")
c.execute("insert into games(platform_id,name) values(2,'SNES/Super Metroid (Japan, USA).zip')")
c.commit()
for x in ("", "-wal"): shutil.copy(str(p) + x, str(d / "copy.sqlite3") + x)  # copy while the WAL is still live
c.close()
print("fixtures written to", d)
