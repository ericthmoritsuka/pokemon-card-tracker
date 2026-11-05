# Scan Benchmark

Measures how often the scanner names the right card, and how long it takes, on 40 TCGdex card
scans run through six simulated captures each (240 reads). It runs the app's own scanner code
(`js/scan/rectify.js`, `read.js`, `ocr.js`, `artwork.js`, `match.js`) in headless Chromium, so a
change to the scanner can be measured before it ships. It is a developer tool: nothing in the app
loads it, and the service worker does not cache it.

## Running It

From the repo root, with Playwright installed somewhere:

```sh
PLAYWRIGHT=/path/to/node_modules/playwright node lab/bench/run.mjs
```

A full run takes about ten minutes. Useful options:

| Option | What it does |
| --- | --- |
| `--passes clean,blur` | Only these captures (default: `clean,blur,glare,tilt,jpeg,nonumber`). |
| `--only 'sv01\|base1'` | Only the cards whose ID matches the regular expression. |
| `--limit 10` | Only the first ten cards. |
| `--throttle 4` | Slows the page's CPU four times, as a mid-range phone, for timings. Each card is first read once at full speed, so only the scanner's own work is timed. Throttling does not fully reach the OCR workers. |
| `--workers 2` | OCR workers in the pool (the app uses two). |
| `--out <file>` | Where the results JSON goes (default: the cache folder). |
| `--crops <dir>` | Saves the straightened card and every OCR crop as PNG files. |
| `--frame` | The whole-frame path instead of the guide's capture (below). |
| `--geometry` | Straightens only, and says how far the box cut lies from the card (below). No text is read, so a run takes a minute or two a pass. |

`REPO=<path>` measures another checkout of the app with the same benchmark, for a before and after:
for example `git worktree add --detach /tmp/base <commit>`, then `REPO=/tmp/base node
lab/bench/run.mjs`.

## Where the Box Lies, and the Whole Frame

Every capture knows where its card really is, so `--geometry` measures the straightening alone
(`rectify.js`): per capture, how far the farthest corner of the box cut lies from the card's, and
how far its top and bottom sit inside the card, as shares of the card's height. A box is right
within 4 %, and short at the bottom when its bottom edge sits more than 4 % inside the card (a
crop that stops at the weakness row is about 12 % short). It prints one line per capture and a
table per pass. With `REPO=`, an older tree is measured the same way, for a before and after
card by card.

`--frame` builds the capture the way the app does since version 34 rather than as the guide's
capture: the card is laid under the guide of a 1080 x 1920 camera frame shown in a 384 x 600 px
video area (`camera.js` `layoutGuide`; Eric's phone is 384 px wide), with the same turn, size,
light, blur, and JPEG as the pass gives it, scaled to the guide. The card is then looked for in
the whole frame (`steady.js` `findCard` on the 360 px copy, judged as `view.js` judges it at the
shutter), the capture cut round the card found (`camera.js` `boxAround`), and its outlines given
to `identify.js` with `--picture`; with no card found, the guide's capture area is read, as the
app reads it. The lines and tables say how many cards were found in the frame. It works with
`--geometry` and with a full run, and needs a tree from version 34 on.

```sh
PLAYWRIGHT=/path/to/node_modules/playwright node lab/bench/run.mjs --geometry --frame \
  --passes slantfull,slant,clean,tilt
```

`window.bench.captureBytes` hands one capture's pixels and its card's corners to Node, for working
on the straightening outside the page.

## Collector Numbers Alone

`--numbers` reads only the collector number of each capture, as the scanner reads a card the
picture narrowed (`read.js` `readNumber`), and scores it against the dataset's number and total:
right, wrong, or unread per capture, with the OCR calls and time. `--dataset <file>` takes another
list in this folder, such as `fullart.json`, 49 full-art cards (special illustration rares,
illustration rares, gold, full-art ultra rares; English and Portuguese) whose numbers are printed
in ringed digits over the art. `--options '{"fullArt":true}'` reads them as the scanner reads a
card the picture index flags as full art; `--verbose` prints everything read. TCGdex has no
Portuguese image for one of them (`swsh3-187`), so 48 are read.

```sh
PLAYWRIGHT=/path/to/node_modules/playwright node lab/bench/run.mjs --dataset fullart.json \
  --numbers --passes clean,blur,jpeg,glare,tilt --options '{"fullArt":true}'
```

## Japanese and Korean Cards

`--dataset asian.json` runs 40 cards whose names are printed in Japanese or Korean (Eric,
2026-11-04): 16 Japanese Pokémon and 8 Japanese Trainers from `SV1S` to `S12a`, picked at random
with a fixed seed from the main run of each set, and 16 Korean copies of Japanese records. TCGdex
has no Korean images for the sets Korean copies are kept on, so the Korean ones are synthetic:
the Japanese scan's name is painted over and the Korean name (PokeAPI's `ko` species name plus
the print's suffix) drawn in its place in Noto Sans CJK KR Bold (`bench.js` `koreanCard`), which
must be installed where Chromium finds it. The right card for a Korean copy is the Japanese
record. The reader gets the options the app gives a card with no language picked
(`js/scan/view.js` `cjkOptions`: Korean tried first) and the pool's model state
(`js/scan/identify.js`): a card whose language is not known reads only with a model already
loaded, so the first card that asks for one starts its load and is read without it; `--options '{"cjk":{"language":"ja"}}'`
reads every name as a card picked as Japanese. A tree from before the Japanese and Korean reading
(`REPO=`) is measured the same way, without them.

```sh
PLAYWRIGHT=/path/to/node_modules/playwright node lab/bench/run.mjs --dataset asian.json \
  --passes clean,blur,glare,tilt,jpeg,nonumber
```

## What It Prints

One line per read (rank of the right card with the number alone, with the name route, and with the
artwork tiebreak too), then a table per capture and over all of them:

- **Number only first**: the collector number and total alone.
- **+Name first** and **top 3**: with the name, HP, and attack route.
- **+Name+art first** and **top 3**: with the artwork tiebreak as well. This is what the scanner
  shows; "right card first out of 240" is the **all** row of this column.

Then, per capture, how many names, numbers, HPs, and card edges were read (and how many names were
the right one), how many reads were sure and how many of those wrong, the median OCR calls, and
the median and 90th percentile of the time from straightening to the match. Last, a table per
group of the dataset (`modern-en`, `japanese-ja`, `korean-ja`, ...) with the names read right, the
right card first and in the first three, sure, wrong but sure, OCR calls, and time, and the
Japanese and Korean model loads (`ocr.js` `asianLoads`).

The captures (`bench.js`, `PASSES`): each card is laid on a table colour with a 12 % margin, turned
and scaled a little, at a seeded random, so every run sees the same images.

| Capture | What changes |
| --- | --- |
| `clean` | Up to 1 degree turned, light blur, JPEG quality 0.9. |
| `blur` | Strong blur (1.6 px). |
| `glare` | A white highlight over the top or bottom of the card. |
| `tilt` | Up to 4.5 degrees turned. |
| `jpeg` | JPEG quality 0.3. |
| `nonumber` | The bottom 12 % blurred out, as a thumb or a sleeve edge would hide the number. |
| `slant` | Turned 10 to 20 degrees either way, so the corners run out of the capture. Not in the default run, which stays comparable with earlier measurements; ask for it with `--passes slant`. |
| `slantfull` | As `slant`, the card 106 to 112 % of the guide's height (95 to 100 % of the capture's), so with the turn its corners run well out of the capture, and its sides out of the capture's 6 % margin: the strong-slant cut (DESIGN.md section 6, measured 2026-11-04, fixed 2026-11-05). The card is centred, so its foot stays mostly in the capture; `low` cuts the foot. Not in the default run. |
| `low` | The card held low: 108 to 112 % of the guide's height, 7 % of it below the middle, turned up to 4 degrees, so its foot runs 5 to 9 % out of the capture while its top is in it. Not in the default run. |
| `lowslant` | As `low`, the card as tall as the guide and turned 6 to 16 degrees. Not in the default run. |

## Images and Data

- Card images are TCGdex scans (`high.webp`, 600 x 825) in the card's own language, downloaded on
  the first run into the cache folder. TCGdex and PokeAPI answers are recorded there too and
  replayed, so later runs need no network and time the scanner, not the connection.
- The cache folder is `BENCH_CACHE`, by default `/tmp/scan-bench-cache`. It must be outside the
  repo; `run.mjs` refuses a folder inside it.
- `dataset.json` lists the 40 cards: 16 modern English, 12 modern Portuguese, and 12 Wizards-era
  English, with their set, number, and name.
- Nothing the benchmark writes belongs in the repo: no images, no recorded answers, no results, no
  logs.

## A Photo of Your Own

`--photo <file> --box x,y,w,h` runs one photo instead of the dataset, read in place: `--box` is the
card's bounding box in the photo, in its pixels. The photo is drawn on a 1080 x 1920 camera frame
with that box fitted to the scanner's guide, in each framing of `--framings` (a comma-separated list
of `name:fit:angle:size`; fit is `width` or `height`, the angle is in degrees, the size shrinks the
card). The default framings are the card's width filling the guide, its height filling the guide,
both turned 12 degrees, and the card at 45 % size. `--truth <card id>` reports where the right card
ranked, and `--stills <dir>` also writes each framing as a Y4M still for Chrome's fake camera
(`--use-file-for-fake-video-capture`), to try auto capture in the app.

**Never commit a personal photo, or anything made from one** (stills, crops, results): the repo is
public. Keep the photo and everything the benchmark makes from it outside the repo.
