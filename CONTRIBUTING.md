# Correcting an entry

1. Edit `data/registry.json` only. `README.md` and `dist/index.html` are generated and will be overwritten.
2. Every changed value needs a source URL on the vendor's own domain and the date you read it, in `sources` and `last_verified`.
3. Quote licence and terms clauses verbatim with the section number. Never paraphrase. If two vendor pages disagree, record both quotes and set `conflict: true`.
4. A value the vendor does not publish is the string `not published`. Never fill a gap from memory, press coverage or a forum.
5. Run `node scripts/build.mjs`; it must print zero validation errors. Then open a pull request. Facts only, no opinion.
