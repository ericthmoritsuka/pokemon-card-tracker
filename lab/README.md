# Scan Lab

A standalone test page that measures how well on-device OCR identifies a physical Pokémon card.
It is not the scanner. It exists to show, before the scanner is built, which parts of a card OCR
reads reliably on a phone and which it does not.

Live at `https://ericthmoritsuka.github.io/pokemon-card-tracker/lab/`. Plain HTML, CSS, and ES
modules, no build step, and nothing imported from the main app, so the two can change separately.

## Opening It on the Phone

**The installed app hides the lab.** The app's service worker (`sw.js`) answers every navigation
under `/pokemon-card-tracker/` with the app shell, so on a phone where the app is installed or
was opened before, the lab URL shows the app instead. Until `sw.js` lets `lab/` through, open the
lab in a Chrome **Incognito tab**, which has no service worker. Do not clear the site's data to get
around it: that deletes the collection stored on the phone.

1. Open the lab URL in an Incognito tab and wait for "OCR engine: ready" (about 5 MB downloads the
   first time: the 3.9 MB WebAssembly core, compressed in transit, and the 2.9 MB English model).
1. Tap **Start camera** and allow camera access. The page asks for 3840 x 2160 and reports what the
   camera gave. **Torch** and a **Zoom** slider appear when the phone supports them.
1. Fill the yellow frame with the card, upright, and tap **Capture**. **Or read a photo** reads an
   image from the gallery instead.
1. Check the **Read** panel: the straightened card, every crop sent to OCR with its raw text, and
   the parsed number, total, set code, copyright year, and language, each with a confidence.
1. In **Match**, tap the card you scanned, or **None of these**.
1. In **Verdict**, correct the printed number and the language if they are wrong, then **Save
   attempt**.
1. **Score** keeps the running totals. **Export JSON** or **Export CSV** before clearing browser
   data; **Reset** deletes the log. The log lives in this browser's `localStorage` and nowhere else.

A Japanese, Korean, or Chinese card counts as a right language when the lab says "Not Latin
script": the English model cannot tell those apart yet.

## What the Page Does

| Step | File | What it does |
| --- | --- | --- |
| Capture | `js/camera.js` | Rear camera at up to 3840 x 2160, continuous focus when offered, torch, zoom. Grabs the full-resolution frame and keeps the guide frame plus 6 % on each side. |
| Straighten | `js/rectify.js` | Finds the card's edges, measures its tilt from the left and right edges, turns it back, and crops to the card. |
| Read | `js/pipeline.js` | Cuts three regions, scales each so its text is 32 px tall, sharpens, finds the text lines inside, and reads each line (Tesseract page segmentation mode 7). |
| Match | `js/match.js` | Looks the number and total up in TCGdex and ranks the candidates. |
| Score | `js/log.js` | Keeps every attempt and its verdict, summarises, exports. |

The three regions:

- **Label row**: the weakness, resistance, and retreat labels. The words decide the language:
  `Weakness`, `Fraqueza`, `Faiblesse`, `Schwäche`, `Debolezza`, `Debilidad` and their two
  neighbours. No Latin label read is reported as "Not Latin script".
- **Number strip, bottom left**: the collector number on Sun & Moon and later cards, the copyright
  year under it, and, from Scarlet & Violet on, the white-on-black set code box (`SVI EN`), read in
  its own pass with the image inverted.
- **Number strip, bottom right**: the number on XY and earlier cards, WotC-era included, with the
  `©1999 Wizards` copyright beside it.

Matching takes the sets whose official card count equals the printed total (and totals one
commonly confused digit away, ranked lower), finds the number in each, and scores each candidate:
set code read in the box, number on the side that era printed it, copyright year matching the
set's release, a Wizards copyright on a set from before 2004, and the detected language's catalog.
It searches the detected language first, then English; "Not Latin script" searches Japanese, then
English.

## OCR Engine

Tesseract.js **7.0.0** (latest on npm, checked 2026-10-01), its worker, and tesseract.js-core
7.0.0, all under `vendor/tesseract`, with their licenses and `SOURCES.txt` (origin and SHA-256 of
each file). `js/ocr.js` gives Tesseract only same-origin paths, so it never falls back to its
default CDN; the headless check below confirms no CDN request.

| File | Size |
| --- | --- |
| `tesseract.esm.min.js` | 63 KB |
| `worker.min.js` | 111 KB |
| `core/tesseract-core-relaxedsimd-lstm.wasm.js` | 3.9 MB |
| `core/tesseract-core-simd-lstm.wasm.js` | 3.9 MB |
| `core/tesseract-core-lstm.wasm.js` | 3.9 MB |
| `lang/eng.traineddata.gz` | 2.95 MB |
| Licenses and `SOURCES.txt` | 36 KB |
| **Total in `vendor`** | **14.9 MB** |

A phone downloads one of the three cores (Tesseract picks it by SIMD support), so about 7 MB, or
about 5 MB over the wire with compression.

**Model: `eng` best_int** (the integerized tessdata_best model, from `@tesseract.js-data/eng`
1.0.0) rather than tessdata_fast (1.98 MB). On the benchmark best_int read the number and total
right on 68 of 84 clean scans against fast's 67, and on 60 of 84 degraded captures against fast's
51, and put the right card first 69 and 55 times against fast's 65 and 47. The legacy engine is
not used, which is why only the LSTM cores are vendored.

## Offline Benchmark

**Method.** 84 Pokémon cards (trainers and energies have no label row), picked at random with a
fixed seed from TCGdex: 26 modern English (`sv01`, `sv03`, `sv06`, `sv08`, `swsh1`, `swsh7`,
`swsh12`, `me01`, `me02`), 20 modern Portuguese (`sv02`, `sv04`, `sv07`, `sv08`, `swsh3`,
`swsh9`, `me01`), 24 WotC-era English (`base1`, `base2`, `base3`, `base5`, `neo1`, `neo2`,
`neo3`), and 14 Japanese (`SV1S`, `SV1V`, `SV2a`, `SV4a`, `SV5K`, `SV7`). Their `high.webp`
images (600 x 825) were downloaded server-side and served same-origin, and a Playwright harness
ran this lab's own `pipeline.js`, `rectify.js`, `match.js`, and vendored Tesseract in headless
Chromium 153, matching against the live TCGdex API. The harness stays outside the repo
(`/tmp/scanlab` on the machine that ran it), and no card image is committed.

Two passes:

- **Clean**: the scan as it is, already cut to the card.
- **Degraded**: a simulated capture as the lab crops it: the guide frame plus its 6 % margin over
  a table-coloured background, the card turned up to 2 degrees, 94 to 102 % of the guide's size,
  up to 2 % off centre, blurred 0.4 to 0.8 px, exposure changed up to 10 %, saved as JPEG at
  quality 0.7. Each card gets the same random values every run.

"Number and total" is both values right. "Language" is the final call (set code box first, then
the label row). "Top 1" and "Top 3" are the right card's rank among the candidates.

**Results**, best_int model:

| Cards | Pass | Number and total | Language | Top 1 | Top 3 |
| --- | --- | --- | --- | --- | --- |
| All 84 | Clean | 81 % (68) | 99 % (83) | 82 % (69) | 86 % (72) |
| All 84 | Degraded | 71 % (60) | 92 % (77) | 65 % (55) | 73 % (61) |
| Modern English, 26 | Clean | 73 % (19) | 100 % (26) | 81 % (21) | 81 % (21) |
| Modern English, 26 | Degraded | 77 % (20) | 92 % (24) | 77 % (20) | 77 % (20) |
| Modern Portuguese, 20 | Clean | 75 % (15) | 95 % (19) | 75 % (15) | 75 % (15) |
| Modern Portuguese, 20 | Degraded | 60 % (12) | 75 % (15) | 60 % (12) | 65 % (13) |
| WotC-era English, 24 | Clean | 88 % (21) | 100 % (24) | 92 % (22) | 96 % (23) |
| WotC-era English, 24 | Degraded | 75 % (18) | 100 % (24) | 67 % (16) | 75 % (18) |
| Japanese, 14 | Clean | 93 % (13) | 100 % (14) | 79 % (11) | 93 % (13) |
| Japanese, 14 | Degraded | 71 % (10) | 100 % (14) | 50 % (7) | 71 % (10) |

Other measurements:

- **Number alone and total alone**: 86 % and 85 % clean, 73 % and 77 % degraded.
- **Secret rares** (number above the total, mostly full-art layouts): 8 of 11 read clean, 4 of 11
  degraded. Regular cards: 60 of 73 clean, 56 of 73 degraded.
- **Set code box** (Scarlet & Violet, Mega Evolution, and Japanese SV cards): read well enough to
  match the set on 15 of 45 clean scans and 8 of 45 degraded. Its language code (`EN`, `PT`) was
  read on 4 clean scans and none degraded, so in practice the label row decided the language.
- **Language errors**: clean, one Portuguese card called Spanish (`Resistência` and `Resistencia`
  fold to one word, and the other two labels were missed). Degraded, 4 Portuguese and 2 English
  cards came back "Not Latin script" because the label row read nothing, and one Portuguese card
  was called Spanish.
- **Straightening**: card edges found on 84 of 84 degraded captures, tilt within 0.1 degree
  (median) of the true value, 60 ms median. Without it, reading the guide frame as cut, number and
  total fell to 52 % (44), top 1 to 49 % (41), and WotC-era cards to 33 %.
- **Time**, headless Chromium on a laptop: OCR median 1.1 s clean and 0.9 s degraded, 90th
  percentile 2.3 s and 2.0 s, slowest 3.9 s. Japanese cards are slowest, because a missing Latin
  label triggers a second, sparse read of the label row. TCGdex lookups took up to 1.6 s with an
  empty cache and a few milliseconds once a set was cached. **These are not phone numbers**: the
  lab's Score panel records the real ones.

**What the benchmark is not.** TCGdex scans are flat, glare-free, and only 600 x 825, while a
phone at 3840 x 2160 sees the card at about 1300 x 1850 with real focus blur, glare, holo foil, and
sleeves. The degraded pass approximates the geometry and some of the softness, not glare or foil.
Real-camera accuracy is unknown until the phone test runs.

## What the Numbers Suggest for the Scanner

**Reliable:**

- **The collector number and total**, read line by line, then checked against the catalog. With
  the confused-digit fallback, the right card is in the top 3 for 86 % of clean scans and 73 % of
  degraded ones.
- **The language label row** for Latin-script cards: 99 % clean, 92 % degraded.
- **Card edges and tilt** from the guide crop. Straightening is cheap and was worth 19 points of
  number accuracy on the degraded pass; the scanner needs it.
- **Copyright line as a dating signal.** `©1999 Wizards` and `©2023` separate sets that share a
  card count (Base Set from HeartGold & SoulSilver Triumphant, both 102 cards; Scarlet & Violet from
  Chilling Reign, both 198).

**Not reliable:**

- **The set code box**, at scan resolution. It is the best tiebreaker on modern cards and the
  only one between Japanese twins such as `SV1S` and `SV1V` (same count, same numbers, same day),
  and it read about one time in three. Worth re-measuring on the phone, where the box is about
  twice the pixels.
- **"Not Latin script"** is only "no Latin label read". A blurred Latin card lands there too, and
  so does any trainer or energy card, which has no label row.
- **Full-art and secret-rare layouts**, whose number is printed in other colours over artwork.

**What to try next:**

1. Run the lab on the phone with 20 to 30 owned cards across eras and languages, with and without
   the torch, and compare the Score panel with this table.
1. Compare the candidates' images with the capture only when text leaves a tie (DESIGN.md
   section 6): the Japanese twin sets, `tk` trainer kits, and promos that share a number.
1. Detect the script properly: Tesseract's `osd` model, or a `jpn` and `kor` pass on the label row
   when no Latin label reads, so "Not Latin script" becomes Japanese, Korean, or Chinese.
1. Read the set code box from a second, higher-resolution grab (`ImageCapture.takePhoto()`), or
   with two binarisation thresholds and a vote.
1. Ask for a second capture when the number's confidence is low, rather than guessing (DESIGN.md
   section 6, scan safety).
1. Add the subset numbers (`TG05/TG30`, `GG01/GG70`) to matching: they parse, but their total is not
   a set's official card count, so they find nothing yet.

## Files

| File | Purpose |
| --- | --- |
| `index.html`, `lab.css` | The page |
| `js/main.js` | Page wiring: capture, read, match, verdict, score |
| `js/camera.js` | Camera start, torch, zoom, guide-frame capture |
| `js/rectify.js` | Card edges, tilt, straighten, crop |
| `js/pipeline.js` | Regions, image preparation, line finding, parsing, language decision |
| `js/ocr.js` | Tesseract worker from `vendor/tesseract` |
| `js/match.js` | TCGdex lookup and candidate ranking |
| `js/log.js` | Attempt log in `localStorage`, summary, JSON and CSV export |
| `vendor/tesseract/` | Tesseract.js 7.0.0, cores, English model, licenses, `SOURCES.txt` |
