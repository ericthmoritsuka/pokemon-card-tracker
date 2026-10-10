# Holder Benchmarks

Measures the scanner in holder mode (a phone held still in a stand over a box, cards dropped in
one by one) on real data: the cards a scan log kept, and a video of a session. They run the app's
own code (`js/scan/drop.js`, `steady.js`, `identify.js`, `picture.js`, `js/vision/`) in Node, so a
change to the detector, the crops, or the matcher can be measured before it ships. Developer tools:
nothing in the app loads them, and the service worker does not cache them.

**Never commit the data or anything made from it.** Videos, frames, scan logs, crops, labels, and
results are personal and the repo is public. Every script refuses to write inside the repo.

Needs Node 22 and `ffmpeg` with `ffprobe` on the path (images and video are decoded through them).

## Identification: the crops of a scan log

```sh
node lab/holder/crops.mjs scan-log-1.json scan-log-2.json --variants --out /tmp/crops.json
```

Every entry with a picture (the straightened card the scanner kept, 420 px tall) goes through
`picture.js` `matchCrops` and `pictureVerdict`, and is scored against the card that was saved for
it (`outcome.card`, else the scanner's own answer when the card was removed unchanged). Logs are
merged by entry id, so a later log that holds an earlier one's entries can be passed beside it.

| Option | What it does |
| --- | --- |
| `--variants` | Also re-crops every card eleven ways a bad crop goes wrong (`recrop.mjs`: moved 6 and 10 %, 10 % smaller and larger, a strip of another card at the bottom, turned 3 degrees, smeared) and scores each. |
| `--repo <dir>` | Runs another checkout's matcher on the same crops, for a before and after (`git archive <commit> \| tar -x -C /tmp/base`). |
| `--only <regexp>` | Only the cards whose saved id matches. |
| `--verbose` | One line per card. |
| `--out <file>` | Every row as JSON. |

The table gives, per crop: right card first (the first artwork group holds it), top 5, sure (and
how many of those were right), unsure, and **wrong but sure**, the failure that matters.

## Detection: a video of a session

```sh
node lab/holder/label.mjs session.mp4 --out /tmp/labels.json --sheet /tmp/sheets
# edit /tmp/labels.json by hand, then:
node lab/holder/replay.mjs session.mp4 --labels /tmp/labels.json --verbose
node lab/holder/replay.mjs session.mp4 --labels /tmp/labels.json --mode v35 --repo /tmp/base
```

`label.mjs` reads every frame, measures how much the picture moves from frame to frame, and proposes
one drop per burst of motion followed by a still picture (`start`, `settle` in seconds), with a
strip of frames per proposal under `--sheet` to check by eye. Edit the JSON by hand:

- delete what is not a drop (a lamp moved, a hand, the zoom changed) and add any drop missed;
- fill each drop's `card`: the id the scanner names it by (a sure answer from the replay, checked
  against the strips, is a good start);
- add `segments`, the parts of the video to report apart: `{name, from, to, light, zoom, speed}`;
- add `reframes`, the times the zoom changed (the replay then starts the detector over, as the app
  does when the zoom button is pressed).

`replay.mjs` decodes the video at the app's frame-loop rate (`--fps`, 8 by default), takes the part
of each frame the screen shows (`camera.js` `layoutGuide` for `--stage`, 384 x 470 CSS pixels on
Eric's phone), and runs it through the frame loop of version 36 (`--mode v36`, `drop.js` as
`view.js` `holderTick` calls it) or version 35 (`--mode v35`, `steady.js` `findCard` and
`createHolderCapture` as version 35's `startLoop` did), then the picture match of each capture (OCR
is never started). Per segment it reports drops noticed exactly once, missed, taken twice, taken
before the card settled (mid-fall), sure and unsure first answers, right among the labelled, wrong
but sure, and how long the picture took (on this machine).

| Option | What it does |
| --- | --- |
| `--busy N` | Holds the loop for N times the time a capture took here: version 35 matched on the main thread; version 36 matches in a worker, so only its own loop work counts. About 4 for a mid-range phone. |
| `--crops <dir>` | Saves each capture's winning crop as a JPEG, to look at. |
| `--out <file>` | Every capture and drop as JSON. |

The video stands in for the camera at its own resolution: a phone video shared through WhatsApp is
478 x 850, against the 2160 x 3840 the scanner grabs, so the picture results here are a lower bound.

## Drops from a scan log

```sh
node lab/holder/replay-log.mjs scan-log.json --identify --verbose
```

From version 36 the scan log keeps two small views of the part of the frame watched for each holder
drop, taken or skipped: as it lay still before, and at the drop. `replay-log.mjs` judges each pair
again with `drop.js` and says where the replay disagrees with what the phone did; `--identify` also
matches the card cut from the small view.

## Files

| File | Purpose |
| --- | --- |
| `lib.mjs` | Decoding and streaming through ffmpeg, scan logs merged, the index loaded, paths kept out of the repo |
| `crops.mjs`, `recrop.mjs` | The identification benchmark and its re-crops |
| `label.mjs` | Drop proposals for a video |
| `replay.mjs`, `no-ocr.mjs` | The detection replay, and the module hook that keeps OCR off in it |
| `replay-log.mjs` | Drops replayed from a scan log's views |
