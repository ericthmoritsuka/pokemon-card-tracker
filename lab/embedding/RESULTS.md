# Image Embeddings: Results

Would a small neural network identify cards better than the perceptual-hash matcher
(`js/vision/matcher.js`, `fingerprint.js`) that the scanner uses since version 22? Measured on
2026-10-15 on Eric's holder-mode data. Lab only: nothing in the app loads these scripts.

## Summary

- **Real crops: almost no difference.** On the 96 crops the scanner kept (scan logs of
  2026-10-09), the hash puts the right card first 92 times. The best network (MobileCLIP2-S0, whole
  card) gets 93 alone and 94 as a fallback when the hash is unsure. On 62 video-drop crops the hash
  is right 62 times; the network alone 59, as a fallback 62.
- **Bad crops: a real gain, but only where the crop is shifted or the wrong size.** Over 1,056
  re-crops (moved, zoomed, pile strips, turned, blurred), the hash gets 919 (87 %). MobileCLIP2
  alone gets 977 (92.5 %); used only when the hash is unsure, 1,007 (95.4 %), with no change to
  the answers the hash is sure of (none of those was wrong). The gain is all in "moved down 10 %"
  (55 to 92) and "10 % smaller" (63 to 92). The network is worse on motion blur (66 against 92)
  and no better on pile strips.
- **Re-ranking the hash's list does not help much.** The right card is somewhere in the hash's
  top 50 for only 975 of the 1,056 re-crops, so any re-rank of that list stops there. Re-ranking
  every answer, or fusing by reciprocal rank, scores below "unsure only" with every model.
- **The whole card embedding needs the Portuguese images.** 94 of the 96 crops are Portuguese
  cards. Without the Portuguese catalog images, MobileCLIP2's whole-card score drops from 93 to
  79 (as kept) and 977 to 773 (re-crops). The fingerprint index uses the English image for a
  Portuguese card; an embedding index would need one entry per language that has its own image.
- **Cost of the best candidate:** 45.6 MB model (float32: both int8 quantisations tried destroy
  it), about 110 ms per crop native and 310 ms through onnxruntime-web WebAssembly on this laptop,
  so an estimated 0.6 to 1 s on a mid-range phone, paid only on unsure crops. Index: 128 bytes per
  catalog image with PCA to 128 dimensions and int8, losing nothing measurable; about 4.9 MB for
  the whole catalog with Portuguese images.
- **The CNNs (MobileNetV3, EfficientNet-Lite0) are fast (11 to 31 ms) but weak alone (76 to 79 %
  on re-crops).** As an unsure-only re-rank they reach 971 and 973, close to the 975 ceiling, at
  17 MB and 14 MB.

**Recommendation: do not adopt yet.** The one real-crop gain is 2 cards of 96, and the large gain
is on synthetic shifted and shrunk crops, which is the failure the research summary's item 2
(wider hash shifts and scales, zero download) targets. Do that first and re-run this benchmark. If
shifted or wrong-size crops still lose cards after it, the candidate is **MobileCLIP2-S0, whole
card, as a second retriever used only when the hash is unsure** (not a replacement, not a re-rank
of the hash's list), shipped lazily (45.6 MB) with a 4.9 MB index, and only after its licence
(below) is confirmed to allow it. If that licence does not fit, DINOv2-small is the fallback
(Apache 2.0, 24 MB), but it gained much less here (971 of 1,056 as unsure-only).

## What Was Measured

### Queries

| Set | n | What |
| --- | --- | --- |
| Log crops as kept | 96 | The straightened card the scanner kept (420 px tall) for every scan-log entry with a saved card, logs merged by id (`lab/holder/crops.mjs` reads them the same way). Truth: the card Eric saved. |
| Log re-crops | 1,056 | Each of the 96 through the 11 re-crops of `lab/holder/recrop.mjs` (moved 6 % four ways, moved down 10 %, 10 % smaller and larger, pile strip 12 % and 20 %, turned 3 degrees, motion blur 9 px). |
| Video drops | 62 | The crops `lab/holder/replay.mjs --crops` saved from the two WhatsApp videos of 2026-10-09 (40 and 22 captures, 478 x 850 video). Labelled by eye: each crop checked against the catalog image of the hash's first answer; all 62 were right, so the hash scores 100 % on this set by construction of the check, not by construction of the label. |

### Reference Set (a stated limit)

The embedding searches 12,751 catalog images, not the whole 25,767-card fingerprint index:

| Part | Cards |
| --- | --- |
| English, every Scarlet & Violet (`sv`) and Mega Evolution (`me`) set | 4,743 |
| Portuguese, the same series, with their own images | 4,567 |
| Artwork twins of the saved cards in the fingerprint index (Japanese prints and reprints) | 4 |
| Every card in the hash's top 50 groups of each log crop as kept (the cards the hash finds hardest to tell apart, from every era) | 3,437 |

Only 4 artwork twins: the saved cards are Mega Evolution cards, and TCGdex has no images for the
Japanese Mega-era sets. 6 images answered 404. Every method is scored by artwork group of the
fingerprint index (a reprint or a Japanese twin of the right card counts as right, as
`crops.mjs` scores the hash). The hash is shown both over its whole index and with its groups
limited to the reference set; the two differ by 4 re-crops, so the hash loses almost nothing to
cards outside the set. Whether the embedding would lose more against the full catalog is **not
measured**; it is the first thing to check before adopting it.

### Candidates

All run in Node with onnxruntime-node 1.22.0 on the same RGB the app has: the art box
(`fingerprint.js` ART) and the whole card edge to edge, each resampled by area to the model's
square input. Each vector at unit length, cosine similarity, a group scored by its best card.

| Model | File | Input | Vector | Licence |
| --- | --- | --- | --- | --- |
| DINOv2-small (`onnx-community/dinov2-small`, `model_quantized.onnx`, uint8) | 24.4 MB | 224, ImageNet mean and std | class token, mean patch token, or both (384 each) | Apache 2.0 |
| MobileCLIP2-S0 image encoder (`felixhrdyn/mobileclip2-s0-onnx`, `vision_model.onnx`) | 45.6 MB | 256, no normalisation (OpenCLIP config) | 512 | Apple Machine Learning Research Model licence (`apple-amlr`) for the weights; the ONNX repository says MIT, but it is a conversion of Apple's weights. Not a standard open-source licence: read its terms before shipping. |
| MobileNetV3-Large (`onnx-community/mobilenetv3_large_100.ra_in1k`), cut at the pooled features | 16.8 MB | 224, ImageNet | 1,280 | Apache 2.0 |
| EfficientNet-Lite0 (`ketiswp/mediapipe-EfficientNet-Lite0-ImageNet-224-fp32-onnx`), cut at the pooled features | 13.5 MB | 224, scaled to -1..1 | 1,280 | Apache 2.0 |

The `int8` (signed) builds of DINOv2 and MobileCLIP2 do not load in onnxruntime's CPU backend
(`ConvInteger` is uint8 only), so DINOv2 was measured with its uint8 build. MobileCLIP2 was
requantised to uint8 here (onnxruntime `quantize_dynamic`, per tensor and per channel): both
give vectors unrelated to the float32 model (cosine 0.02), so MobileCLIP2 ships as float32 or
not at all. DINOv2 uint8 against float32: cosine 0.988 median, same nearest neighbour on 114 of
150 images; q4: 0.92 and 89 of 150, and slower, so not pursued.

TCGdex images: the API and its data are free to use; the card images are The Pokémon Company's.
As for the fingerprint index, confirm TCGdex's terms allow bulk processing before building an
index from them (DESIGN.md section 6).

## Accuracy

Right card first, and in the top 5 (artwork group). Each model's best scorer is shown; "unsure"
uses the app's own verdict (`picture.js` `pictureVerdict`), which was sure on 680 of the 1,214
queries and never wrong.

| Method | Log crops as kept (96) | Log re-crops (1,056) | Video drops (62) |
| --- | --- | --- | --- |
| Hash, whole index (the app) | 92 (95.8 %), top 5 95.8 % | 919 (87.0 %), top 5 90.3 % | 62 (100 %) |
| Hash, reference set | 92, 95.8 % | 923 (87.4 %), 90.6 % | 62 |
| Ceiling of any re-rank: right card in the hash top 50 | 92 | 975 (92.3 %) | 62 |
| **MobileCLIP2-S0, whole card, alone** | **93 (96.9 %), 99.0 %** | **977 (92.5 %), 96.1 %** | 59 (95.2 %), 100 % |
| MobileCLIP2, re-rank of the hash top 50 | 91 | 968 (91.7 %) | 62 |
| MobileCLIP2, reciprocal rank fusion with the hash (k = 60) | 92, 99.0 % | 973 (92.1 %), 97.3 % | 62 |
| MobileCLIP2, re-rank the hash top 50 only when unsure | 92 | 972 (92.0 %) | 62 |
| **MobileCLIP2, its own answer only when the hash is unsure** | **94 (97.9 %), 99.0 %** | **1,007 (95.4 %), 97.4 %** | **62** |
| DINOv2-small uint8, art box, mean patch token, alone | 92, 95.8 % | 914 (86.6 %), 90.7 % | 61 |
| DINOv2, its own answer only when unsure | 92 | 971 (92.0 %), 94.2 % | 62 |
| MobileNetV3, art box + whole card, alone | 84 (87.5 %) | 801 (75.9 %) | 55 |
| MobileNetV3, re-rank only when unsure | 92 | 971 (92.0 %) | 62 |
| EfficientNet-Lite0, art box + whole card, alone | 79 (82.3 %) | 838 (79.4 %) | 54 |
| EfficientNet-Lite0, re-rank only when unsure | 92 | 973 (92.1 %) | 62 |

By re-crop, right card first:

| Crop | Hash (app) | MobileCLIP2 alone | MobileCLIP2 when unsure |
| --- | --- | --- | --- |
| as kept | 92 | 93 | 94 |
| moved right, left, down, up 6 % | 92, 89, 91, 90 | 93, 95, 93, 92 | 94, 95, 93, 93 |
| moved down 10 % | 55 | 90 | 92 |
| 10 % smaller | 63 | 92 | 92 |
| 10 % larger | 92 | 96 | 96 |
| pile strip 12 %, 20 % | 85, 81 | 84, 83 | 89, 84 |
| turned 3 degrees | 89 | 93 | 93 |
| motion blur 9 px | 92 | 66 | 86 |

Which part of the card, alone, right first on as kept / re-crops / video:

| Scorer | Art box | Whole card | Both (mean cosine) |
| --- | --- | --- | --- |
| MobileCLIP2-S0 | 90 / 843 / 59 | **93 / 977 / 59** | 93 / 962 / 61 |
| DINOv2-small, class token | 78 / 774 / 52 | 53 / 650 / 41 | 88 / 864 / 58 |
| DINOv2-small, mean patch token | **92 / 914 / 61** | 7 / 96 / 5 | 88 / 869 / 55 |
| MobileNetV3 | 82 / 723 / 53 | 46 / 500 / 32 | 84 / 801 / 55 |
| EfficientNet-Lite0 | 71 / 697 / 54 | 41 / 525 / 30 | 79 / 838 / 54 |

Without the Portuguese reference images (Portuguese cards found through their English image
only): MobileCLIP2 whole card 79 / 773 / 57, art box 90 / 845 / 58; DINOv2 mean art box 92 / 910
/ 59. The art box does not care about the language; the whole card does, and is what makes
MobileCLIP2 good.

Margins (lead of the first group over the second): MobileCLIP2's largest lead when wrong was 0.030
cosine, and 79 % of all queries were right with a larger lead, against 81 % for the hash's own gap
rule. A sure rule for the network is possible, but not needed for the recommended use, where an
unsure crop goes to the tray's top 5 anyway (MobileCLIP2's top 5 holds the right card 97 to 99 %
of the time, the hash's 90 % on re-crops).

## Cost

Measured on this laptop (Intel i7-1270P, load average about 2), one crop, both regions; the
recommended use needs one region (the whole card), so half of these numbers.

| Model | File MB | Native, 1 thread | Native, 4 threads | WebAssembly (onnxruntime-web 1.22.0 in Node, SIMD, 1 thread) |
| --- | --- | --- | --- | --- |
| DINOv2-small fp32 | 88.5 | 397 ms | 276 ms | not run |
| DINOv2-small uint8 | 24.4 | 192 ms | 157 ms | 744 ms |
| DINOv2-small q4 | 16.9 | 387 ms | 314 ms | 1,271 ms |
| MobileCLIP2-S0 fp32 | 45.6 | 217 ms | 104 ms | 618 ms |
| MobileNetV3-Large fp32 | 16.8 | 22 ms | 11 ms | 82 ms |
| EfficientNet-Lite0 fp32 | 13.5 | 31 ms | 12 ms | 124 ms |

- **Phone estimate.** A mid-range Android phone's single core is about 2 to 3 times slower than
  this laptop's, so MobileCLIP2 whole card through WebAssembly is about **0.6 to 1 s per crop**
  (310 ms here), DINOv2 uint8 art box about 0.7 to 1.1 s, MobileNetV3 both regions about 0.2 s.
  Paid only on unsure crops (24 % of the logged crops as kept). WebGPU was not measured; no
  number is claimed for it. Model load: 0.2 to 0.4 s here, plus the first download.
- **Download.** MobileCLIP2-S0 45.6 MB (float32 only, see above), DINOv2-small uint8 24.4 MB,
  MobileNetV3 16.8 MB (4.5 MB uint8, which is slower on CPU and was not scored), EfficientNet-Lite0
  13.5 MB. Against 1.1 MB for the fingerprint index.
- **Index per catalog image** (MobileCLIP2 whole card, 512 dimensions; PCA fitted on the
  reference vectors):

| Stored as | Bytes per image | Alone: as kept / re-crops / video | When unsure: as kept / re-crops / video |
| --- | --- | --- | --- |
| float32 | 2,048 | 93 / 977 / 59 | 94 / 1,007 / 62 |
| int8 | 512 | 94 / 976 / 59 | 95 / 1,007 / 62 |
| PCA 256, int8 | 256 | 93 / 981 / 62 | 93 / 1,010 / 62 |
| **PCA 128, int8** | **128** | **93 / 974 / 62** | **93 / 1,007 / 62** |
| PCA 64, int8 | 64 | 92 / 923 / 59 | 94 / 977 / 62 |
| PCA 256, 1 bit (Hamming) | 32 | 93 / 882 / 59 | 93 / 949 / 61 |
| PCA 128, 1 bit | 16 | 89 / 805 / 52 | 93 / 903 / 61 |

  MobileNetV3 (2,560 dimensions with both regions) compresses badly: PCA 256 int8 drops it from
  801 to 719 alone, and from 971 to 957 as an unsure-only re-rank.
- **Full catalog.** The fingerprint index's 25,767 images plus about 12,700 Portuguese images
  (every Portuguese card with its own image, since the whole card needs its language): about
  38,500 entries, **4.9 MB at PCA 128 int8** (9.9 MB at PCA 256), plus a 256 KB projection
  matrix. Building it: about 250 MB more downloads than the fingerprint build (the Portuguese
  images), and 110 ms per image native on one thread, about 70 minutes single threaded or a
  quarter of that on four threads; suited to the same weekly job as `build-index.mjs`.

## Limits of These Numbers

- 96 real crops from one evening, 94 of them Portuguese Mega Evolution cards, and 62 video crops
  that the hash already gets right. The large differences are on synthetic re-crops.
- The embedding searched 12,751 images, not the full catalog (see Reference Set).
- The video labels were checked by eye against the hash's answer, so that set cannot show a hash
  error the eye also missed.
- No model was fine-tuned. TCG-AR (research summary) reached 85 % top 1 on real photos with a
  trained ResNet-50; these are off-the-shelf features.
- Times for the reference embedding runs were taken under other load (load average 10 to 40);
  the cost table above was re-measured on a quiet machine.

## Running It

Nothing below writes inside the repo; data, models, and caches stay in `/tmp` (or wherever
`EMB_CACHE` and `EMB_MODELS` point). Never commit them.

```sh
# Outside the repo: onnxruntime-node 1.22.0 (skip the CUDA download), onnxruntime-web 1.22.0
# for timing-wasm.mjs, sharp 0.33.5 for fast catalog decoding.
cd /tmp/emb/node && ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm install onnxruntime-node@1.22.0 onnxruntime-web@1.22.0 sharp@0.33.5
export ORT_NODE=/tmp/emb/node/node_modules/onnxruntime-node SHARP=/tmp/emb/node/node_modules/sharp
export EMB_CACHE=/tmp/emb/tcgdex EMB_MODELS=/tmp/emb/models
# Models: the files in the Candidates table into $EMB_MODELS, named as lab/embedding/lib.mjs
# MODELS says; the two CNNs cut at their pooled features with onnx.utils.extract_model
# (MobileNetV3 at /flatten/Flatten_output_0, EfficientNet-Lite0 at
# efficientnet-lite0/model/head/Squeeze1).

node lab/embedding/refs.mjs scan-log-1.json scan-log-2.json        # reference set and images
node lab/embedding/embed-refs.mjs mclip2-fp32 --threads 2           # one model, both regions
node lab/holder/replay.mjs video.mp4 --crops /tmp/emb/video/a       # video crops, then label [{file, truth}]
node lab/embedding/measure.mjs scan-log-1.json scan-log-2.json --variants \
  --video /tmp/emb/video/labels.json --models mclip2-fp32 --out /tmp/emb/rows-mclip2.json
node lab/embedding/summarize.mjs /tmp/emb/rows-*.json --ablation --variants
node lab/embedding/compress.mjs /tmp/emb/rows-mclip2.json --scorer mclip2-fp32/card [--without pt]
node lab/embedding/timing.mjs scan-log-1.json
node lab/embedding/timing-wasm.mjs scan-log-1.json --models mclip2-fp32
node lab/embedding/quant.mjs dinov2-fp32 dinov2-uint8
```

| File | What it does |
| --- | --- |
| `lib.mjs` | The candidates, regions, preprocessing, decoding, embedding cache |
| `hash.mjs` | The app's `matchCrops` with a top 50 instead of 5 |
| `refs.mjs` | Builds the reference set and downloads its images gently (4 at a time, cached, 404s remembered) |
| `embed-refs.mjs` | Embeds the reference set with one model |
| `measure.mjs` | Hash and embedding answers for every query |
| `summarize.mjs` | The accuracy tables, fusions, margins |
| `compress.mjs` | int8, PCA, and binary forms of an index, and the no-Portuguese check |
| `timing.mjs`, `timing-wasm.mjs`, `quant.mjs` | Cost and quantisation checks |
