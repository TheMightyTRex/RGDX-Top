# Interface translations

`fr.py` and `es.py` map the English text the page shows to French and Spanish. `{n}` stands for any number, and
`{name}` for a value filled in by the page (system names, sources). Keys must match the English text exactly,
including leading or trailing punctuation, because the page translates text pieces between links and bold text.

To update:

1. `python3 build.py`, then `cd test && node harvest.js` to list every English string the page shows (`test/out/strings.json`).
2. Add missing entries to `fr.py` and `es.py`.
3. Regenerate the JSON the build uses:

```
python3 -c "import sys,json; sys.path.insert(0,'tools/i18n'); from fr import FR; from es import ES; [json.dump(d, open(f'data/i18n-{n}.json','w'), ensure_ascii=False, indent=1, sort_keys=True) for n, d in (('fr', FR), ('es', ES))]"
```

Then rebuild. Text that has no entry stays in English.
