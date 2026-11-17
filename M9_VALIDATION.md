# M9 — Real-world data validation

**Status: harness built and self-checked; the real measurement has NOT been run.** It needs two inputs only you can provide: a real parcel file, and a listing page captured in your own browser for the *same area*. Until then there is no false-match rate, no extraction coverage and no real capacity figure, and nothing in this document should be read as one.

Evidence classes used below:
- **Synthetic self-check** — proves the harness arithmetic; says nothing about Signal's accuracy.
- **Synthetic workload** — generated data, reproducible; shows the *shape* of a cost, not real behaviour.
- **Real measurement** — none yet.

## 1. Environment and baseline (measured)

- Branch `claude/modest-pascal-4vhgb8`, `HEAD` `8ebf61b`. **`HEAD` moved during this work** (from `6b5cb3e`) because another session committed; the dataset work (M8, M1B, M9 tooling) is **uncommitted** on top. Record the working-tree state with every run (the harness does).
- Node 24.9, macOS (darwin arm64 class), Chromium via Playwright 1.56.1 (installed `--no-save`).
- Baseline before M9 changes, on this tree: typecheck clean; `feltkit test` 123 pass / 0 fail / 0 skipped; extension e2e 4 of 4 pass.
- A `feltkit dev` server (pid 85393) was already running for this project; it was not touched. E2E runs use a mirror copy of the repo (G-TEST-2).

**Matching rules and thresholds, unchanged** (`lib/datasets/resolve.ts`):
1. Parcel ID on the page equals a record's ID → match, high. Duplicate IDs in the file → ambiguous.
2. Normalized street address (`normalizeAddress`: text before the first comma; US suffix/direction tables; needs a leading house number) matches exactly one record → with a coordinate within **250 m** (`ADDRESS_CORROBORATION_M`) or inside its polygon: match, high; with coordinates farther than that and not inside: **conflict**; with no coordinates: match, medium. Several rows on one address: narrowed by a point within **30 m**, else ambiguous.
3. Point inside exactly one polygon → match, medium; inside several → ambiguous.
4. Exactly one record within **30 m** (`COORD_MATCH_M`) → match, medium; several → ambiguous.
5. Otherwise unmatched; nothing to match on → `no_identity`. A page value always outranks a dataset value.

Lookup uses a 0.001° grid; polygons spanning over 10,000 cells are not indexed (G-DATA-19). Mapping treats a column as numeric when 80% of its values parse.

**Limits:** FeltKit request body 2 MiB → the panel refuses over 1.8 MB of file text; one Files object 1 MiB → refuses over 1 MiB gzipped; `MAX_ROWS` 200,000; the API's declared text limit 8 MB is not reachable (G-DATA-10).

**Gaps carried in:** G-DATA-9 to 15 and G-TEST-2, G-TEST-3 exist as recorded, not renumbered. New ones are G-M9-1, G-DATA-16 to 20 and G-TEST-4.

## 2. Real parcel dataset — NOT YET MEASURED
Needed: county, source URL, retrieval date, licence/terms, format, bytes, gzip bytes, records, columns, fields. Whether the file fits is a result, not a precondition: it will not be split to make it fit. If it does not fit, the harness records exact bytes against each limit.

## 3. Real listing capture — first real capture measured (extraction only; one page, one site)

**Capture 1 — Zillow, a for-sale search results page (map + list), captured with the extension in the owner's own Chromium session on 2026-11-17 (about 15:51 local), "Download what Signal read" file, 507 KB.** Reported on its own: it says nothing about any other site. The file is the owner's and is not committed; its terms of use have not been reviewed (§8).

| What | Measured |
|---|---|
| Results the page declares | 613 ("613 results"; the map says "500 of 613 homes") |
| List slots on the page | 41, of which **9 hold a rendered card** and 32 are empty placeholders (the list is virtualized: cards render as they scroll into view) |
| Map markers in the DOM | 500, each a price pill or dot with a pixel position only: no address, id or coordinates |
| Listings Signal extracted **before** this change | 0 typed as listings. The 9 cards were found but left `Unknown` (the 46 "entities" were events, places, addresses and wrappers) |
| Listings Signal extracted **after** this change | **9 of the 9 rendered cards**, each as one listing with price, beds, baths, floor area, coordinates, assessed value, property type |
| Coverage of what the page declares | **9 of 613 (1.5%)** from the page's DOM. The remaining 604 are not in the page; they are in data the page fetches |
| Fields usable for parcel matching | address and coordinates on 9 of 9 (read from an embedded JSON record on each card) |

Two separate causes were found and are different problems:
1. **A defect (fixed):** the cards were typed `Unknown` because an item's type was decided once, when first created, and never revisited as its facts were merged; and each card's embedded JSON record (coordinates, assessed value, property type) was never read. See `lib/page/extract.ts` (`lateTyping`, `embeddedRecords`) and `tests/lib/embedded-records.test.ts` (synthetic fixture built to the structure; fake addresses).
2. **A limit of reading rendered pages (not fixed):** a virtualized list plus a data-less marker layer cannot be read to completeness from the DOM. See G-FEED-1.

Observation to carry into the matching work: this page **already states the assessed value** for each listing (from the site's own data). A parcel dataset's assessed value for the same property is then a second, independent statement; where they differ, the page's value keeps precedence and the difference is shown, as designed.

Runbook for further captures (you do the browsing; nothing is crawled or fetched by Signal):
1. Load `extension/dist` unpacked in Chrome (`npm run build:extension`), connect to your instance, sign in as a **member** (a viewer cannot capture or import).
2. Open the listing page for the same county in a normal tab, as you would. Press **Analyze this page**. Repeat per page you want covered.
3. On each, use **Download what Signal read** and keep the file. Note the site, page type, date/time, how many listings you can see, and the count the page declares.
4. Do not commit these files. Sanitize anything you intend to turn into a fixture, and check the site's terms first.

## 4. Run the measurement
```
# A. the parcel file and each snapshot, through the library code the server uses
node scripts/m9-measure.ts --parcels PARCELS.csv --page READ1.html::https://site/page1 [--page …] \
     --review-sheet sheet.csv --out run1.json

# B. a person looks up each listing in sheet.csv INDEPENDENTLY of Signal (the sheet contains no Signal result),
#    and fills expected_parcel_id_or_none_or_indistinguishable. Convert to labels.json:
#    [{"listing":"<url or street address>","expected":{"parcelId":"…"} | "none" | "indistinguishable"}]
node scripts/m9-measure.ts --parcels PARCELS.csv --mapping approved-mapping.json --page … --labels labels.json --out run2.json

# C. the same file and snapshot through the actual extension panel (UI path), with timings
SIGNAL_M9_PARCELS=PARCELS.csv SIGNAL_M9_SNAPSHOT=READ1.html SIGNAL_M9_OUT=ui.json node --test tests/e2e/m9-real.e2e.ts
```
Use the mapping you approved in the panel for B (the harness says when it measured the proposed one instead). Stop `feltkit dev` first, or run from a copy (G-TEST-2). The e2e replays your saved snapshot from a local server, so it is real page structure but not a live capture.

**Reading the result:** `accuracy.counts.false_match` and `falseMatchRate` (with its Wilson interval) are the headline. A lost match (`safe_*`) is a miss, not an error; a false match is an error. With a small sample, "0 false matches" bounds the rate, it does not make it zero (0 of 20 is consistent with up to about 16%).

**Thresholds:** 30 m and 250 m stay as they are until a baseline run exists. `resolution.pinDistanceM` (distance from a listing's pin to the parcel it matched) is the evidence for any later change. If a threshold is changed, re-run on the same labels and report both; that sample is then no longer an independent validation of the new setting.

## 5. What was checked without real data (synthetic)
- **Harness self-check** (`tests/lib/m9-measure.test.ts`, 4 tests): verdict logic, a deliberately wrong label counted as a false match, an undecidable listing joined anyway counted as false, Wilson interval, quantiles, input profile. `candidateIdentities` was extracted from `augment()` without behaviour change (the dataset tests still pass).
- **UI path self-check** (`tests/e2e/m9-real.e2e.ts` run on the synthetic fixtures): import, mapping review, approval, capture, evaluate, remove all record outcomes and timings; removal restores the original results. Not a result.
- **Synthetic scale workload** (`node scripts/m9-scale.ts`, deterministic, ~160 bytes/row, 12 columns):

| records | file MB | gzip MB | parse ms | map ms | resolve ms | per-evaluate ms | fits 1.8 MB | fits 1 MiB gz |
|---|---|---|---|---|---|---|---|---|
| 1,000 | 0.16 | 0.04 | 3.8 | 1.8 | 1.4 | 7 | yes | yes |
| 5,000 | 0.80 | 0.20 | 15.2 | 6.3 | 3.9 | 25 | yes | yes |
| 20,000 | 3.22 | 0.80 | 51.8 | 27.6 | 10.5 | 90 | no | yes |
| 50,000 | 8.06 | 2.01 | 123 | 52.5 | 37.3 | 213 | no | no |
| 100,000 | 16.12 | 4.01 | 251 | 95.9 | 88.6 | 436 | no | no |
| 200,000 | 32.35 | 8.02 | 488 | 195.7 | 218.2 | 901 | no | no |

  Reading: at this width the request limit binds first (~11,000 rows) and per-evaluate cost at that size is ~50 ms, so re-parsing is not a problem at accepted sizes. A real county file is far wider, so its row ceiling is likely much lower — **a hypothesis to test, not a finding**. Times are one machine, single run.
- **A real defect found by that workload and fixed:** a 200,000-row numeric column crashed profiling (G-DATA-16), with a regression test (synthetic-derived).
- **A real defect found while handling a user report:** a viewer account saw raw 403s with Import offered (G-DATA-20); fixed and tested (unit + e2e).

## 6. Sections that need real data (all NOT YET MEASURED)
Extraction coverage (listings visible vs declared vs extracted; identity and location fields on the page) · matching confusion and false-match rate · address and coordinate behaviour · augmentation correctness against source records · real import/evaluation/memory · real-input regression fixtures.

## 7. Fair-housing
Unresolved and unchanged. `FAIR_HOUSING_REVIEW.md` records what the scenario uses, how risk can enter, options, and the legal/policy questions. The validation uses only property and financial attributes as criteria.

## 8. Claims that remain unverified
Signal's accuracy on any real listing site or county; that its address normalization works on real situs addresses; that 30 m / 250 m are sensible; that a real county file fits or evaluates quickly; that real listing pages expose usable address and coordinates; that any listing site's terms permit this use. One county and one site, once measured, will be a first boundary and not general coverage.
