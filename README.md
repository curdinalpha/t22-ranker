# t22 ranker: pre-token protocol ranker (DISPATCH-05, curdinalpha)

Deterministic, zero-network, zero-dependency Node 22+ TypeScript CLI. It reads an offline protocol snapshot and writes `board.json`, a ranked list of pre-token base protocols. Each row has an implied launch FDV band and an on-chain playbook for its category. Every dropped record is listed in `stripped[]` with a reason.

## Run
```
node --experimental-strip-types ranker.ts rank --in snapshot.json --out board.json   # Node 22.6+
node ranker.ts --generate-synthetic 4200 --seed t22 --out board.json                # Node 23.6+ (strip-types on by default)
node ranker.ts gen --count 4200 --seed t22 --out corpus.json                         # seeded synthetic corpus
node --experimental-strip-types --test ranker.test.ts                                # 80 tests
```
Exit codes: 0 ok, 2 bad input, 3 fewer than 100 rows (the board contract is 100..4000; `--min-rows` overrides it, `--max-rows` truncates, capped at 4000).
Input can be a JSON array or `{ "protocols": [...] }`. Fields: name, category, chains, tvl_usd, tvl_7d_delta, fees_30d_usd, revenue_30d_usd, symbol, parent_protocol, governance_links, description.

## Pipeline
0. Normalize. Text goes through NFKC, then zero-width characters are removed and Cyrillic/Greek homoglyphs are folded to ASCII. Numbers accept `"$12.5M"`, `"1,234"` and `"3e6"`. NaN, Infinity and junk become null and get an `input_notes` entry. Negative fees become 0. Revenue above fees is capped at fees. `tvl_7d_delta` is read as a fraction, except values with |v| > 10, which are read as percent. Records are then sorted by (normalized name key, canonical JSON), so the output does not depend on input order or key order.
1. Invalid: a missing name, or a TVL that is missing, NaN or ≤ 0, gives `invalid:*`.
2. Duplicates: when the normalized name is the same, the higher-TVL copy is kept (`duplicate:same_name`).
3. Derivatives, checked before live tokens so each record gets the right strip reason:
   - category: Liquid Staking / Liquid Restaking / Wrapped / Receipt
   - bridged ticker: `USDC.e`, `USDT.wh`, `SOL_axl`
   - LP receipt: pair tickers like `ETH-USDC LP`, plus SLP/BPT/GLP/JLP…
   - wrapper ticker: recursive prefix/suffix parsing against about 45 base assets, e.g. `PT-weETH` resolves to PT, then WE, then ETH. Single-letter prefixes only count when they sit directly on a base asset, so a real ticker like `KASOL` is not flagged.
   - disguised ticker: the same checks, but the raw symbol contained homoglyphs, zero-width or fullwidth characters
   - base-ticker clone: e.g. a protocol whose symbol is `ETH`
   - name markers and description markers (LST/LRT, 1:1 redeemable, ERC-4626 shares, receipt token…)
   - forked single-asset wrapper
4. Live tokens: any non-placeholder symbol; or snapshot/tally/coingecko/cmc/dexscreener/realms/explorer-token links; or a description like "governance token XYZ is live / listed on …". Placeholders (`-`, `N/A`, `TBA`, `none`…) are ignored. Explicit pre-token wording ("no token yet", "points program") overrides description-only evidence.
5. Families: parent chains are resolved (cycle-safe). If any ancestor was stripped, its descendants inherit the strip (`live_token:inherited_from_parent`). The surviving members of a family collapse into one row:
   - parent record present: TVL = `max(parent, Σ children)`, never parent + children
   - parent record absent: the sibling modules are summed under the parent name
   Members that were merged in are listed as `dedupe:merged_into_family`.
6. Wash clamps, in order. All statistics come from sorted arrays.
   - TVL spike haircut: growth is credited up to +100% per 7 days.
   - sector MAD clamp: log10(TVL) is capped at the sector median + 3 × 1.4826 × MAD. σ is at least 0.25 decades. Sectors with fewer than 5 members use the global distribution.
   - fee-starved TVL: annual fees / TVL < 0.05% while TVL is above the sector median means TVL is cut down to `max(sector median, fees / 0.0005)`.
   - fee spike: annual fees above 500% of TVL are clamped.
7. FDV band. Each sector has a model of FDV/TVL, FDV/annual fees and FDV/annual revenue multiples (table `SECTORS`). The components (TVL, fees, revenue) are combined in a weighted geometric mean with weights 0.4/0.3/0.3, renormalized when a component is missing. The result is multiplied by a momentum factor: 1 + 0.5 × clamp(Δ7d, ±20%). Band = mid × e^±spread, where spread = max(0.35, weighted log-dispersion of the components), plus 0.15 if any clamp fired, plus 0.15 if a component is missing. Confidence is high/medium/low.
8. Rank by `fdv_usd.mid` descending, ties broken by name key. Each sector has a 3..8 step playbook, filled in with the protocol name and its primary chain (the alphabetically first chain). The steps always include verifying the contracts, using a small capped wallet and revoking approvals.

## Output (board.json)
`schema`, `input` (record count plus a SHA-256 of the canonical input), `params` (every weight and clamp threshold), `summary` (strip counts by class and by reason, which reconcile to the input count), `rows[]`, `stripped[]`.
Each row contains: rank, name, category/sector, chains, `fdv_usd {low, mid, high}`, the per-component FDV, the multiples used, raw TVL vs effective TVL, annualized fees/revenue, revenue/TVL, sector median, `clamp_flags`, confidence, `keep_reasons`, `input_notes`, `family {parent, members, tvl_rule}`, and `playbook[]`.

## Determinism
No clock, no `Math.random`, no locale-dependent comparison, no network, and only `node:` built-ins are imported. Sorting uses plain code-unit comparison. The synthetic corpus comes from mulberry32 seeded with FNV-1a(seed). Tests check that output bytes are identical for reversed input, shuffled input, record key order flipped, the `{protocols}` envelope, two in-process runs, and two separate CLI processes.
