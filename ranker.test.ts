// ranker.test.ts - node --test (Node >= 22.6 with --experimental-strip-types, native on >= 23.6)
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  rank, serialize, normalize, derivativeVerdict, liveTokenVerdict, wrapperBase, normSymbol, foldText, nameKey,
  toNum, normDelta, sectorOf, playbook, generateCorpus, sha256, canonicalJson, median, mulberry32, seedHash,
  MIN_ROWS, MAX_ROWS, SECTORS, type RawRecord,
} from './ranker.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const RANKER = join(HERE, 'ranker.ts');

let n = 0;
const P = (over: RawRecord = {}): RawRecord => {
  n++;
  return {
    name: `Basefi ${n}`, category: 'Dexes', chains: ['Solana'], tvl_usd: 10_000_000, tvl_7d_delta: 0.02,
    fees_30d_usd: 50_000, revenue_30d_usd: 10_000, symbol: '', parent_protocol: '', governance_links: [],
    description: 'Pre-token AMM, points program live.', ...over,
  };
};
const deriv = (over: RawRecord) => derivativeVerdict(normalize(P(over)));
const live = (over: RawRecord) => liveTokenVerdict(normalize(P(over)));
const reasonOf = (board: ReturnType<typeof rank>, name: string) => board.stripped.find((s) => s.name === name)?.reason;
const rowOf = (board: ReturnType<typeof rank>, name: string) => board.rows.find((r) => r.name === name);

describe('liquid-staking / restaking / bridge wrappers', () => {
  for (const sym of ['stETH', 'wstETH', 'jitoSOL', 'mSOL', 'bSOL', 'JupSOL', 'rETH', 'cbETH', 'sfrxETH', 'ankrETH']) {
    test(`LST ticker ${sym} is stripped`, () => {
      const v = deriv({ symbol: sym });
      assert.equal(v.strip, true); assert.match(v.reason, /^derivative:/);
    });
  }
  for (const sym of ['rsETH', 'ezETH', 'weETH', 'pufETH']) {
    test(`LRT ticker ${sym} is stripped`, () => assert.equal(deriv({ symbol: sym }).reason, 'derivative:wrapper_ticker'));
  }
  for (const sym of ['USDC.e', 'USDT.wh', 'SOL_axl', 'ETH-b']) {
    test(`bridged ticker ${sym} is stripped`, () => assert.equal(deriv({ symbol: sym }).reason, 'derivative:bridged_ticker'));
  }
  test('WBTC / cbBTC wrapped BTC stripped', () => {
    assert.equal(wrapperBase('WBTC'), 'BTC'); assert.equal(wrapperBase('CBBTC'), 'BTC');
  });
  test('nested wrapper PT-weETH resolves to ETH', () => assert.equal(wrapperBase(normSymbol('PT-weETH')), 'ETH'));
  test('category Liquid Staking strips even without symbol', () => assert.equal(deriv({ category: 'Liquid Staking', symbol: '' }).reason, 'derivative:category'));
  test('category Liquid Restaking strips', () => assert.equal(deriv({ category: 'Liquid Restaking' }).reason, 'derivative:category'));
  test('name marker "Bridged USDC" strips', () => assert.equal(deriv({ name: 'Bridged USDC Hub' }).reason, 'derivative:name_marker'));
  test('name marker "Wrapped Staked SOL" strips', () => assert.equal(deriv({ name: 'Wrapped Staked SOL' }).reason, 'derivative:name_marker'));
  test('description "ERC-4626 vault shares" strips as receipt', () => assert.equal(deriv({ description: 'ERC-4626 vault shares for a USDC loop.' }).reason, 'derivative:description_marker'));
  test('LP pair ticker ETH-USDC LP strips', () => assert.equal(deriv({ symbol: 'ETH-USDC LP' }).reason, 'derivative:lp_receipt'));
  test('vault receipt yvUSDC / aUSDC / mooBNB strip', () => {
    for (const s of ['yvUSDC', 'aUSDC', 'mooBNB']) assert.equal(deriv({ symbol: s }).strip, true, s);
  });
  test('forked single-asset wrapper strips', () => assert.equal(deriv({ description: 'A fork of Lido that wraps a single asset 1:1.' }).reason, 'derivative:fork_wrapper'));
});

describe('disguised tickers', () => {
  test('Greek Epsilon wΕTH folds to WETH', () => assert.equal(deriv({ symbol: 'w\u0395TH' }).reason, 'derivative:disguised_ticker'));
  test('Cyrillic т in wsтETH folds to WSTETH', () => assert.equal(normSymbol('ws\u0442ETH'), 'WSTETH'));
  test('zero-width joiner st\u200BETH detected', () => assert.equal(deriv({ symbol: 'st\u200BETH' }).reason, 'derivative:disguised_ticker'));
  test('fullwidth ｊｉｔｏＳＯＬ detected', () => assert.equal(deriv({ symbol: '\uFF4A\uFF49\uFF54\uFF4F\uFF33\uFF2F\uFF2C' }).reason, 'derivative:disguised_ticker'));
  test('$-prefixed Cyrillic $ѕOL impersonating SOL detected', () => assert.equal(deriv({ symbol: '$\u0455OL' }).reason, 'derivative:disguised_ticker'));
  test('separator tricks W-ETH and st.ETH detected', () => {
    assert.equal(deriv({ symbol: 'W-ETH' }).strip, true); assert.equal(deriv({ symbol: 'st.ETH' }).strip, true);
  });
  test('plain ETH ticker on a non-ETH protocol is a base-ticker clone', () => assert.equal(deriv({ symbol: 'ETH' }).reason, 'derivative:base_ticker_clone'));
  test('ordinary live ticker is NOT misread as a wrapper (KASOL single-letter chain guard)', () => {
    assert.equal(wrapperBase('KASOL'), '');
    assert.equal(deriv({ symbol: 'KASOL' }).strip, false);
    assert.equal(live({ symbol: 'KASOL' }).reason, 'live_token:symbol');
  });
});

describe('live tokens vs pre-token', () => {
  test('placeholder symbols are not live tokens', () => {
    for (const s of ['', '-', 'N/A', 'TBA', 'tbd', 'none', '??']) assert.equal(live({ symbol: s }).strip, false, JSON.stringify(s));
  });
  test('snapshot / tally / coingecko links mark a live token', () => {
    for (const l of ['https://snapshot.org/#/x.eth', 'https://www.tally.xyz/gov/x', 'https://www.coingecko.com/en/coins/x']) assert.equal(live({ governance_links: [l] }).reason, 'live_token:governance_or_market_link');
  });
  test('forum-only governance link does not mark a token', () => assert.equal(live({ governance_links: ['https://forum.basefi.xyz'] }).strip, false));
  test('description "governance token ABC is live" marks a token', () => assert.equal(live({ description: 'Governance token ABC is live on major venues.' }).reason, 'live_token:description'));
  test('pre-token signal overrides weak description evidence', () => assert.equal(live({ description: 'No token yet; token TBA after points program. Token is live soon? no.' }).strip, false));
});

describe('parent-child dedupe', () => {
  test('child of a pre-token parent is merged, TVL = max(parent, sum(children)) not parent+child', () => {
    const b = rank([P({ name: 'Rootswap', tvl_usd: 100e6 }), P({ name: 'Rootswap V2', parent_protocol: 'Rootswap', tvl_usd: 30e6 }), P({ name: 'Rootswap V3', parent_protocol: 'Rootswap', tvl_usd: 40e6 })]);
    assert.equal(b.rows.length, 1);
    assert.equal(b.rows[0].name, 'Rootswap');
    assert.equal(b.rows[0].tvl_usd, 100e6);
    assert.equal(b.rows[0].family.tvl_rule, 'max(parent, sum(children))');
    assert.equal(reasonOf(b, 'Rootswap V2'), 'dedupe:merged_into_family');
  });
  test('children exceeding the parent record use the children sum', () => {
    const b = rank([P({ name: 'Smallroot', tvl_usd: 5e6 }), P({ name: 'Bigkid A', parent_protocol: 'Smallroot', tvl_usd: 30e6 }), P({ name: 'Bigkid B', parent_protocol: 'Smallroot', tvl_usd: 40e6 })]);
    assert.equal(b.rows[0].tvl_usd, 70e6);
  });
  test('children of a tokenized parent inherit the strip', () => {
    const b = rank([P({ name: 'Tokenfi', symbol: 'TKF' }), P({ name: 'Tokenfi Earn', parent_protocol: 'Tokenfi' })]);
    assert.equal(b.rows.length, 0);
    assert.equal(reasonOf(b, 'Tokenfi Earn'), 'live_token:inherited_from_parent');
  });
  test('grandchild inherits through a multi-level chain', () => {
    const b = rank([P({ name: 'Gp', symbol: 'GPX' }), P({ name: 'Mid', parent_protocol: 'Gp' }), P({ name: 'Leaf', parent_protocol: 'Mid' })]);
    assert.equal(reasonOf(b, 'Leaf'), 'live_token:inherited_from_parent');
  });
  test('siblings with absent parent record are summed once under the parent name', () => {
    const b = rank([P({ name: 'Ghost A', parent_protocol: 'Ghost Labs', tvl_usd: 1e6 }), P({ name: 'Ghost B', parent_protocol: 'Ghost Labs', tvl_usd: 2e6 })]);
    assert.equal(b.rows.length, 1); assert.equal(b.rows[0].name, 'Ghost Labs'); assert.equal(b.rows[0].tvl_usd, 3e6);
  });
  test('parent cycles terminate and collapse to one family', () => {
    const b = rank([P({ name: 'Cyc A', parent_protocol: 'Cyc B' }), P({ name: 'Cyc B', parent_protocol: 'Cyc A' })]);
    assert.equal(b.rows.length, 1);
  });
  test('case/homoglyph-different parent names still link (nameKey)', () => {
    assert.equal(nameKey('R\u043Ef SWAP'), nameKey('rofswap'));
    const b = rank([P({ name: 'Rofswap', tvl_usd: 9e6 }), P({ name: 'Rof Lend', parent_protocol: 'ROF SWAP'.replace(' ', '') })]);
    assert.equal(b.rows.length, 1);
  });
  test('exact duplicate names keep the higher-TVL copy', () => {
    const b = rank([P({ name: 'Dupe', tvl_usd: 1e6 }), P({ name: 'dupe ', tvl_usd: 5e6 })]);
    assert.equal(b.rows.length, 1); assert.equal(b.rows[0].tvl_usd, 5e6);
    assert.equal(b.summary.stripped_by_reason['duplicate:same_name'], 1);
  });
});

describe('outlier clamping', () => {
  const sector = (k: number, over: RawRecord = {}) => Array.from({ length: k }, (_, i) => P({ name: `Peer ${i}`, tvl_usd: 10e6 * (1 + i / 10), fees_30d_usd: 60_000 + i * 1000, ...over }));
  test('wash TVL far above sector distribution is MAD-clamped', () => {
    const b = rank([...sector(20), P({ name: 'Washer', tvl_usd: 5e12, fees_30d_usd: 60_000 })]);
    const r = rowOf(b, 'Washer')!;
    assert.ok(r.clamp_flags.some((f) => f.startsWith('sector_mad_clamp')), r.clamp_flags.join());
    assert.ok(r.tvl_effective_usd < 1e10);
  });
  test('fee-starved giant TVL is clamped to fee-implied level', () => {
    const b = rank([...sector(20), P({ name: 'Starved', tvl_usd: 2e9, fees_30d_usd: 10 })]);
    const r = rowOf(b, 'Starved')!;
    assert.ok(r.clamp_flags.includes('fee_starved_tvl_clamp'));
    assert.ok(r.tvl_effective_usd <= 2e9 && r.tvl_effective_usd >= r.sector_median_tvl_usd);
  });
  test('7d TVL spike is haircut to +100% weekly credit', () => {
    const b = rank([...sector(10), P({ name: 'Spiky', tvl_usd: 50e6, tvl_7d_delta: 9 })]);
    const r = rowOf(b, 'Spiky')!;
    assert.ok(r.clamp_flags[0].startsWith('tvl_spike_haircut'));
    assert.equal(r.tvl_effective_usd, round2(50e6 / 10 * 2));
  });
  test('percent-style delta (2500) is read as +2500%', () => assert.equal(normDelta(2500), 25));
  test('wash fee spike (fees > 500% TVL/yr) is clamped', () => {
    const b = rank([...sector(10), P({ name: 'Feewash', tvl_usd: 20_000, fees_30d_usd: 5e6 })]);
    assert.ok(rowOf(b, 'Feewash')!.clamp_flags.includes('fee_spike_clamp'));
  });
  test('clamps lower confidence and widen the band', () => {
    const b = rank([...sector(20), P({ name: 'Washer2', tvl_usd: 5e12, fees_30d_usd: 1 })]);
    const r = rowOf(b, 'Washer2')!;
    assert.notEqual(r.confidence, 'high');
    assert.ok(r.fdv_usd.high / r.fdv_usd.low > Math.exp(1.0));
  });
});

function round2(x: number) { return Math.round(x * 100) / 100; }

describe('NaN / missing fields', () => {
  test('toNum handles "$12.5M", "1,234", "3e6", NaN, null', () => {
    assert.equal(toNum('$12.5M'), 12.5e6); assert.equal(toNum('1,234'), 1234); assert.equal(toNum('3e6'), 3e6);
    assert.equal(toNum('NaN'), null); assert.equal(toNum(null), null); assert.equal(toNum(Infinity), null);
  });
  test('missing / NaN / negative TVL is stripped as invalid with a reason', () => {
    const b = rank([P({ name: 'Nan', tvl_usd: 'NaN' }), P({ name: 'Neg', tvl_usd: -1 }), P({ name: 'Nul', tvl_usd: null })]);
    for (const nm of ['Nan', 'Neg', 'Nul']) assert.equal(reasonOf(b, nm), 'invalid:missing_or_nonpositive_tvl');
  });
  test('missing name stripped; non-object rows survive without crashing', () => {
    const b = rank([P({ name: '' }), null, 42, 'x', [] as unknown as RawRecord]);
    assert.equal(b.rows.length, 0); assert.equal(b.summary.stripped_by_reason['invalid:missing_name'], 5);
  });
  test('missing fees/revenue still yields a TVL-only band, flagged in input_notes', () => {
    const b = rank([P({ name: 'Nofees', fees_30d_usd: null, revenue_30d_usd: undefined })]);
    const r = b.rows[0];
    assert.deepEqual(Object.keys(r.fdv_components_usd), ['tvl']);
    assert.ok(r.input_notes.includes('missing:fees_30d_usd'));
    assert.ok(r.fdv_usd.low > 0 && r.fdv_usd.low < r.fdv_usd.mid && r.fdv_usd.mid < r.fdv_usd.high);
  });
  test('revenue > fees is capped; negative fees floored', () => {
    const r = normalize(P({ fees_30d_usd: -5, revenue_30d_usd: 9 }));
    assert.equal(r.fees, 0); assert.equal(r.revenue, 0);
  });
  test('chains given as comma string are parsed, deduped and sorted', () => assert.deepEqual(normalize(P({ chains: 'Solana, Base,Solana' })).chains, ['Base', 'Solana']));
  test('no output number is NaN/Infinity', () => {
    const txt = serialize(rank(generateCorpus(600, 'nan-check')));
    assert.ok(!/NaN|Infinity/.test(txt));
  });
});

describe('scoring, sectors, playbooks', () => {
  test('sector synonyms map deterministically', () => {
    assert.equal(sectorOf('DEXes'), 'dex'); assert.equal(sectorOf('Perpetuals'), 'derivatives'); assert.equal(sectorOf('Money Market'), 'lending');
    assert.equal(sectorOf('Liquid Restaking'), 'liquid-restaking'); assert.equal(sectorOf(''), 'other');
  });
  test('every sector playbook has 3..8 steps', () => {
    for (const s of Object.keys(SECTORS)) { const pb = playbook({ name: 'X', sector: s, primaryChain: 'Solana' }); assert.ok(pb.length >= 3 && pb.length <= 8, s); }
  });
  test('playbook is tailored: substitutes name and chain', () => {
    const pb = playbook({ name: 'Zedswap', sector: 'dex', primaryChain: 'Base' });
    assert.ok(pb.some((s) => s.includes('Zedswap'))); assert.ok(pb.some((s) => s.includes('Base')));
  });
  test('higher fees => higher implied FDV, ceteris paribus', () => {
    const b = rank([P({ name: 'Lowfee', fees_30d_usd: 10_000 }), P({ name: 'Highfee', fees_30d_usd: 500_000, revenue_30d_usd: 100_000 })]);
    assert.equal(b.rows[0].name, 'Highfee');
  });
  test('FDV band ordering low < mid < high for all rows', () => {
    for (const r of rank(generateCorpus(800, 'band')).rows) assert.ok(r.fdv_usd.low <= r.fdv_usd.mid && r.fdv_usd.mid <= r.fdv_usd.high, r.name);
  });
  test('rows carry explainable keep reasons and every strip carries a reason+detail', () => {
    const b = rank(generateCorpus(800, 'explain'));
    assert.ok(b.rows.every((r) => r.keep_reasons.length > 0));
    assert.ok(b.stripped.every((s) => s.reason.includes(':') && s.detail.length > 0));
  });
  test('summary counts reconcile: input = stripped + rows + truncated', () => {
    const b = rank(generateCorpus(1500, 'reconcile'));
    assert.equal(b.summary.input_records, b.summary.stripped_total + b.summary.rows_emitted + b.summary.truncated);
  });
  test('maxRows truncates and never exceeds 4000', () => {
    const b = rank(generateCorpus(600, 'trunc'), { maxRows: 50 });
    assert.equal(b.rows.length, 50); assert.equal(b.rows[49].rank, 50);
    assert.equal(rank([], { maxRows: 99999 }).params.max_rows, MAX_ROWS);
  });
});

describe('determinism', () => {
  test('canonicalJson is key-order independent', () => assert.equal(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] }), canonicalJson({ a: [2, { c: 2, d: 1 }], b: 1 })));
  test('median of even/odd arrays', () => { assert.equal(median([3, 1, 2]), 2); assert.equal(median([4, 1, 2, 3]), 2.5); });
  test('seeded PRNG + generator are reproducible and seed-sensitive', () => {
    assert.equal(mulberry32(seedHash('a'))(), mulberry32(seedHash('a'))());
    assert.equal(sha256(JSON.stringify(generateCorpus(500, 's1'))), sha256(JSON.stringify(generateCorpus(500, 's1'))));
    assert.notEqual(sha256(JSON.stringify(generateCorpus(500, 's1'))), sha256(JSON.stringify(generateCorpus(500, 's2'))));
  });
  test('input-order independence: reversed + shuffled input => identical bytes', () => {
    const corpus = generateCorpus(1200, 'order');
    const rnd = mulberry32(7);
    const shuffled = corpus.map((x) => [rnd(), x] as const).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
    const a = serialize(rank(corpus));
    assert.equal(serialize(rank(corpus.slice().reverse())), a);
    assert.equal(serialize(rank(shuffled)), a);
  });
  test('object key order inside records does not change output', () => {
    const corpus = generateCorpus(300, 'keys');
    const flipped = corpus.map((r) => Object.fromEntries(Object.entries(r).reverse()));
    assert.equal(serialize(rank(flipped)), serialize(rank(corpus)));
  });
  test('accepts {protocols:[...]} envelope identically', () => {
    const c = generateCorpus(300, 'env');
    assert.equal(serialize(rank({ protocols: c })), serialize(rank(c)));
  });
  test('two in-process runs on 4,200 records are byte-identical and in contract', () => {
    const c = generateCorpus(4200, 't22');
    const a = serialize(rank(c)); const b = serialize(rank(generateCorpus(4200, 't22')));
    assert.equal(sha256(a), sha256(b));
    const rows = JSON.parse(a).rows.length;
    assert.ok(rows >= MIN_ROWS && rows <= MAX_ROWS, String(rows));
  });
  test('two separate CLI processes produce byte-identical board.json (4,200 records)', () => {
    const dir = mkdtempSync(join(tmpdir(), 't22-'));
    const run = (out: string) => execFileSync(process.execPath, [...process.execArgv.filter((a) => a.includes('strip-types') || a.includes('warnings')), RANKER, '--generate-synthetic', '4200', '--seed', 't22', '--out', out], { stdio: ['ignore', 'ignore', 'pipe'] });
    run(join(dir, 'a.json')); run(join(dir, 'b.json'));
    const a = readFileSync(join(dir, 'a.json')); const b = readFileSync(join(dir, 'b.json'));
    assert.ok(a.equals(b));
  });
  test('CLI rank from file equals in-process rank, and exits 3 below 100 rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 't22-'));
    const c = generateCorpus(800, 'file');
    writeFileSync(join(dir, 'in.json'), JSON.stringify(c));
    const args = [...process.execArgv.filter((a) => a.includes('strip-types') || a.includes('warnings')), RANKER, 'rank', '--in', join(dir, 'in.json'), '--out', join(dir, 'o.json')];
    execFileSync(process.execPath, args, { stdio: 'ignore' });
    assert.equal(readFileSync(join(dir, 'o.json'), 'utf8'), serialize(rank(c)));
    writeFileSync(join(dir, 'tiny.json'), JSON.stringify(c.slice(0, 10)));
    assert.throws(() => execFileSync(process.execPath, [...args.slice(0, -4), '--in', join(dir, 'tiny.json'), '--out', join(dir, 't.json')], { stdio: 'ignore' }), (e: any) => e.status === 3);
  });
  test('foldText is idempotent', () => { const s = 'w\u0395TH \uFF21'; assert.equal(foldText(foldText(s)), foldText(s)); });
});
