"""Build a small, licensed variable Chinese font for the research interface.

Requires fonttools[woff] (4.66.1 used for the checked-in artifact).
The original Google Fonts TTF stays outside Git; arbitrary paper text uses system fallback.
"""
import argparse
import hashlib
import json
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont

parser = argparse.ArgumentParser()
parser.add_argument("--source", type=Path, required=True)
parser.add_argument("--out-dir", type=Path, required=True)
args = parser.parse_args()
repo = Path(__file__).resolve().parents[1]
feature = repo / "apps/web/app/features/research"
files = [repo / "apps/web/app/routes/research.tsx", *feature.glob("*.tsx"), feature / "fonts/ui-copy.txt"]
corpus = "".join(path.read_text(encoding="utf-8") for path in files)
codepoints = sorted({ord(char) for char in corpus if ord(char) > 127})
font = TTFont(args.source, recalcTimestamp=False)
available = font.getBestCmap()
missing = [f"U+{cp:04X}" for cp in codepoints if cp not in available]
codepoints = [cp for cp in codepoints if cp in available]
options = subset.Options()
options.name_IDs = ["*"]
options.name_languages = ["*"]
subsetter = subset.Subsetter(options=options)
subsetter.populate(unicodes=codepoints)
subsetter.subset(font)
# The original license reserves Source; give this modified UI subset its own family name.
names = font["name"]
for record in list(names.names):
    if record.nameID in {1, 4, 16, 21}:
        names.setName("EP Reader Sans UI", record.nameID, record.platformID, record.platEncID, record.langID)
    elif record.nameID == 6:
        names.setName("EPReaderSans-UI", record.nameID, record.platformID, record.platEncID, record.langID)
    elif record.nameID == 3:
        names.setName("EPReaderSans-UI-2026", record.nameID, record.platformID, record.platEncID, record.langID)
args.out_dir.mkdir(parents=True, exist_ok=True)
output = args.out_dir / "ep-reader-ui.woff2"
font.flavor = "woff2"
font.save(output)
css = '@font-face{font-family:"EP Reader Sans UI";font-style:normal;font-weight:100 900;font-display:swap;src:url("./ep-reader-ui.woff2") format("woff2");unicode-range:' + ",".join(f"U+{cp:X}" for cp in codepoints) + ';}\n'
(args.out_dir / "font.css").write_text(css, encoding="utf-8")
manifest = {
    "source": "https://github.com/google/fonts/tree/main/ofl/notosanssc",
    "source_sha256": hashlib.sha256(args.source.read_bytes()).hexdigest(),
    "artifact_sha256": hashlib.sha256(output.read_bytes()).hexdigest(),
    "glyph_codepoints": len(codepoints), "bytes": output.stat().st_size,
    "missing_decorative_characters": missing,
    "fonttools": "4.66.1", "brotli": "1.2.0",
}
(args.out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
print(json.dumps(manifest))
