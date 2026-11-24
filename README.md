# site-generator-speed-01

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/metano0206/site-generator-speed-01/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/metano0206/site-generator-speed-01/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

**The makefun-site 1.0.0 static site build, reimplemented to run about 3.4 times faster.** `solve.js` is a dependency-free ES module whose `run(input)` returns, for each case input `{site, templates, files}`, exactly the output tree the reference `build()` produces — byte-for-byte, including the build report and every error line. On the kit's practice set (3 cases, 1,091 Markdown sources) it answers in about 233 ms of CPU where the house baseline takes about 806 ms, with identical output on every case and identical bytes across repeated runs.

How it is fast: the Markdown renderer is a single fused pass (no intermediate block tree), with bulk HTML escaping behind a no-specials test, regex hopping scans for emphasis/link closers instead of per-character walks, and char-code line classifiers instead of per-line regular expressions. Front matter is read by a line-offset scanner that never copies the body. Slugs are computed through an ASCII fast path (NFKD is the identity there) behind a per-build cache, links are resolved once per source and target, and the template engine renders into a shared root scope with integer node kinds. Nothing is cached between cases, nothing is random, and there is no network or clock use.

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=in MAKEFUN_OUTPUT_DIR=out node main.ts
```

`main.ts` reads `cases.json` (an array of `{id, input}`) from the input directory — `/input` unless `MAKEFUN_INPUT_DIR` says otherwise — answers each case alone with `run()` from `solve.js`, and writes `answers.json` to the output directory (`/output` unless `MAKEFUN_OUTPUT_DIR` says otherwise).

License: MIT (see LICENSE).
