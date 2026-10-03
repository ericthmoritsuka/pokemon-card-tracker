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

`REPO=<path>` measures another checkout of the app with the same benchmark, for a before and after:
for example `git worktree add --detach /tmp/base <commit>`, then `REPO=/tmp/base node
lab/bench/run.mjs`.

## What It Prints

One line per read (rank of the right card with the number alone, with the name route, and with the
artwork tiebreak too), then a table per capture and over all of them:

- **Number only first**: the collector number and total alone.
- **+Name first** and **top 3**: with the name, HP, and attack route.
- **+Name+art first** and **top 3**: with the artwork tiebreak as well. This is what the scanner
  shows; "right card first out of 240" is the **all** row of this column.

Then, per capture, how many names, numbers, HPs, and card edges were read, and the median and 90th
percentile of the time from straightening to the match.

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
