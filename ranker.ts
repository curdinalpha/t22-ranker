#!/usr/bin/env node
// ranker.ts - curdinalpha / Stellarator DISPATCH-05 (t=22)
// Deterministic, zero-network, zero-npm-dependency pre-token protocol ranker.
//   1. strips live-token protocols and wrapper derivatives (wrapped / liquid-staked /
//      restaked / bridged / LP + vault receipts / forked single-asset wrappers),
//   2. collapses parent/child families so TVL is never double counted,
//   3. estimates implied launch FDV bands from sector multiples with robust wash clamps,
//   4. attaches a 3..8 step on-chain playbook per category.
// Every stripped record gets a machine-readable reason. No clock, no randomness
// (except the seeded synthetic generator), no locale, no network.
// Runs on Node >= 22.6 (--experimental-strip-types) and natively on Node >= 23.6.

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export const SCHEMA = 'curdinalpha.t22.board/v1';
export const MIN_ROWS = 100;
export const MAX_ROWS = 4000;

// ---------------------------------------------------------------- types
export interface RawRecord { [k: string]: unknown }
export interface Rec {
  idx: number; // position after canonical sort (stable id inside one run)
  name: string;
  key: string;
  category: string;
  sector: string;
  chains: string[];
  tvl: number | null;
  delta: number | null;
  fees: number | null;
  revenue: number | null;
  symbolRaw: string;
  symbol: string; // normalized (NFKC, homoglyph-folded, upper, no separators)
  parentRaw: string;
  parentKey: string;
  links: string[];
  description: string;
  notes: string[]; // input-quality notes (coercions)
  canon: string; // canonical JSON for tie-breaks
}
export interface Strip { name: string; key: string; reason: string; detail: string }
export interface Verdict { strip: boolean; reason: string; detail: string }

// ---------------------------------------------------------------- determinism helpers
export function cmp(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }

export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') {
    if (typeof v === 'number' && !Number.isFinite(v)) return 'null';
    return JSON.stringify(v === undefined ? null : v);
  }
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  const o = v as Record<string, unknown>;
  return '{' + Object.keys(o).filter((k) => o[k] !== undefined).sort(cmp).map((k) => JSON.stringify(k) + ':' + canonicalJson(o[k])).join(',') + '}';
}

export function sha256(s: string): string { return createHash('sha256').update(s).digest('hex'); }

export function round(x: number, dp: number): number {
  if (!Number.isFinite(x)) return 0;
  const f = 10 ** dp;
  const r = Math.round(x * f) / f;
  return Object.is(r, -0) ? 0 : r;
}

export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// ---------------------------------------------------------------- normalization
const ZERO_WIDTH = /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u206A-\u206F\uFEFF]/g;
// Cyrillic / Greek / Latin-ext letters that render like ASCII capitals.
const HOMOGLYPHS: Record<string, string> = {
  'А': 'A', 'В': 'B', 'Е': 'E', 'К': 'K', 'М': 'M', 'Н': 'H', 'О': 'O', 'Р': 'P', 'С': 'C', 'Т': 'T', 'Х': 'X', 'У': 'Y',
  'Ѕ': 'S', 'І': 'I', 'Ј': 'J', 'Ԁ': 'D', 'Ԛ': 'Q', 'Ԝ': 'W',
  'а': 'a', 'в': 'b', 'е': 'e', 'к': 'k', 'м': 'm', 'н': 'h', 'о': 'o', 'р': 'p', 'с': 'c', 'т': 't', 'х': 'x', 'у': 'y',
  'ѕ': 's', 'і': 'i', 'ј': 'j', 'ԁ': 'd', 'ԛ': 'q', 'ԝ': 'w', 'ӏ': 'l',
  'Α': 'A', 'Β': 'B', 'Ε': 'E', 'Ζ': 'Z', 'Η': 'H', 'Ι': 'I', 'Κ': 'K', 'Μ': 'M', 'Ν': 'N', 'Ο': 'O', 'Ρ': 'P', 'Τ': 'T', 'Υ': 'Y', 'Χ': 'X',
  'α': 'a', 'ε': 'e', 'ι': 'i', 'κ': 'k', 'ν': 'v', 'ο': 'o', 'ρ': 'p', 'τ': 't', 'υ': 'u', 'χ': 'x',
  'ı': 'i', 'ſ': 's', 'Ꞵ': 'B', 'ꞵ': 'b',
};

export function foldText(s: string): string {
  let out = '';
  for (const ch of s.normalize('NFKC').replace(ZERO_WIDTH, '')) out += HOMOGLYPHS[ch] ?? ch;
  return out;
}

export function nameKey(s: string): string {
  return foldText(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** Normalized ticker: folded, upper, '$' and separators removed. */
export function normSymbol(s: string): string {
  return foldText(s).toUpperCase().replace(/^\$+/, '').replace(/[^A-Z0-9]/g, '');
}

const PLACEHOLDER_SYMBOLS = new Set(['', 'NA', 'NONE', 'NULL', 'NIL', 'TBA', 'TBD', 'UNDEFINED', 'NOTOKEN', 'PRETOKEN', 'SOON', 'UNKNOWN', 'POINTS', '0']);
export function isPlaceholderSymbol(norm: string): boolean { return PLACEHOLDER_SYMBOLS.has(norm); }

function toStr(v: unknown): string {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return '';
}

/** Coerce numbers incl. "1,234.5", "$12.5M", "3e6", "NaN" -> null. */
export function toNum(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const t = v.trim().replace(/[$,_\s]/g, '');
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)([kmbt])?$/i.exec(t);
  if (!m) return null;
  const mult: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 };
  const n = Number(m[1]) * (m[2] ? mult[m[2].toLowerCase()] : 1);
  return Number.isFinite(n) ? n : null;
}

function toList(v: unknown): string[] {
  let arr: unknown[] = [];
  if (Array.isArray(v)) arr = v;
  else if (typeof v === 'string') arr = v.split(/[,;|]/);
  const set = new Set<string>();
  for (const x of arr) { const s = toStr(x); if (s) set.add(s); }
  return [...set].sort(cmp);
}

const SECTOR_SYNONYMS: [RegExp, string][] = [
  [/liquid\s*re-?stak/, 'liquid-restaking'],
  [/liquid\s*stak|^lst$|staking pool/, 'liquid-staking'],
  [/re-?stak/, 'restaking'],
  [/perp|deriv|option|futures/, 'derivatives'],
  [/^dex|amm|exchange|swap|orderbook/, 'dex'],
  [/lend|borrow|money market|credit/, 'lending'],
  [/cdp|stablecoin|stable/, 'cdp'],
  [/yield|aggregat|farm|vault/, 'yield'],
  [/bridge|cross.?chain|interop/, 'bridge'],
  [/launch|ido/, 'launchpad'],
  [/nft/, 'nft'],
  [/gam/, 'gaming'],
  [/rwa|real.?world/, 'rwa'],
  [/insur/, 'insurance'],
  [/oracle/, 'oracle'],
  [/predict/, 'prediction'],
  [/pay/, 'payments'],
  [/social/, 'social'],
  [/privacy|mixer/, 'privacy'],
  [/infra|rpc|indexer|data|wallet|tooling|sdk/, 'infrastructure'],
];
export function sectorOf(category: string): string {
  const c = foldText(category).toLowerCase().trim();
  if (!c) return 'other';
  for (const [re, s] of SECTOR_SYNONYMS) if (re.test(c)) return s;
  return 'other';
}

/** tvl_7d_delta convention: fraction (0.12 = +12%). |v| > 10 is read as percent. */
export function normDelta(v: number | null): number | null {
  if (v === null) return null;
  const f = Math.abs(v) > 10 ? v / 100 : v;
  return Math.max(-1, f);
}

export function normalize(raw: RawRecord, idx = 0): Rec {
  const r = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as RawRecord;
  const notes: string[] = [];
  const num = (field: string): number | null => {
    if (r[field] === undefined || r[field] === null || r[field] === '') { notes.push(`missing:${field}`); return null; }
    const n = toNum(r[field]);
    if (n === null) notes.push(`non_numeric:${field}`);
    return n;
  };
  const name = foldText(toStr(r.name)).replace(/\s+/g, ' ');
  let tvl = num('tvl_usd');
  let fees = num('fees_30d_usd');
  let revenue = num('revenue_30d_usd');
  const delta = normDelta(num('tvl_7d_delta'));
  if (fees !== null && fees < 0) { notes.push('negative:fees_30d_usd->0'); fees = 0; }
  if (revenue !== null && revenue < 0) { notes.push('negative:revenue_30d_usd->0'); revenue = 0; }
  if (fees !== null && revenue !== null && revenue > fees) { notes.push('revenue_gt_fees:capped'); revenue = fees; }
  if (fees === null && revenue !== null) { fees = revenue; notes.push('fees_from_revenue'); }
  if (tvl !== null && tvl < 0) { notes.push('negative:tvl_usd'); tvl = null; }
  const category = toStr(r.category);
  const symbolRaw = toStr(r.symbol);
  const parentRaw = toStr(r.parent_protocol);
  const rec: Rec = {
    idx, name, key: nameKey(name), category, sector: sectorOf(category),
    chains: toList(r.chains), tvl, delta, fees, revenue,
    symbolRaw, symbol: normSymbol(symbolRaw),
    parentRaw, parentKey: nameKey(parentRaw),
    links: toList(r.governance_links).map((l) => l.toLowerCase()),
    description: foldText(toStr(r.description)).replace(/\s+/g, ' '),
    notes, canon: canonicalJson(r),
  };
  if (rec.parentKey === rec.key) { rec.parentKey = ''; rec.notes.push('self_parent_ignored'); }
  return rec;
}

// ---------------------------------------------------------------- derivative detection
/** Base assets that wrappers are minted against. (Short tickers < 3 chars excluded to avoid false hits.) */
export const BASE_ASSETS = new Set([
  'ETH', 'BTC', 'SOL', 'USDC', 'USDT', 'DAI', 'USDE', 'USDS', 'FRAX', 'LUSD', 'GHO', 'PYUSD', 'FDUSD', 'EUR', 'EURC',
  'AVAX', 'MATIC', 'POL', 'BNB', 'ATOM', 'DOT', 'NEAR', 'SUI', 'APT', 'TIA', 'INJ', 'FTM', 'ADA', 'TRX', 'TON',
  'HYPE', 'SEI', 'ARB', 'CRV', 'CVX', 'BAL', 'AURA', 'GMX', 'MNT', 'BERA', 'KAIA', 'XRP', 'LTC', 'DOGE', 'CELO', 'KAVA',
]);
/** Wrapper / LST / LRT / receipt prefixes (longest match first). */
export const WRAP_PREFIXES = [
  'JITO', 'JUP', 'SFRX', 'FRX', 'ANKR', 'STADER', 'SWELL', 'PUF', 'WST', 'STK', 'RS', 'EZ', 'WE', 'CB', 'ST', 'MV',
  'YV', 'MOO', 'AM', 'PT', 'YT', 'LP', 'BB', 'SW', 'OS', 'SA', 'HS', 'VS', 'GL', 'LS', 'UN', 'SV', 'W', 'R', 'E', 'B',
  'M', 'H', 'X', 'A', 'C', 'S', 'J', 'V', 'Y', 'K', 'T', 'I', 'L', 'P', 'Z',
].sort((a, b) => b.length - a.length || cmp(a, b));
const WRAP_SUFFIXES = ['WORMHOLE', 'AXL', 'LZ', 'OFT', 'LP', 'E', 'B', 'X'];

/** Returns the base asset if `sym` is (recursively) a wrapper of one, else ''. */
export function wrapperBase(sym: string, depth = 0): string {
  if (depth > 4 || sym.length < 3) return '';
  for (const p of WRAP_PREFIXES) {
    if (sym.length > p.length && sym.startsWith(p)) {
      const rest = sym.slice(p.length);
      if (BASE_ASSETS.has(rest)) return rest;
      if (p.length === 1) continue; // single-letter prefixes only directly on a base asset
      const deeper = wrapperBase(rest, depth + 1);
      if (deeper) return deeper;
    }
  }
  for (const s of WRAP_SUFFIXES) {
    if (sym.length > s.length && sym.endsWith(s)) {
      const rest = sym.slice(0, -s.length);
      if (BASE_ASSETS.has(rest)) return rest;
    }
  }
  return '';
}

const LP_SYMBOL = /(^|[^A-Z])(SLP|BPT|UNIV2|UNIV3|CAKELP|GLP|HLP|JLP|ALP|MLP|VLP|CLP|LPT)$/;
const BRIDGE_SUFFIX_RAW = /[.\-_ ](e|b|wh|axl|lz|oft|wormhole|bridged)$/i;
const PAIR_RAW = /^\$?([A-Za-z0-9]{2,10})\s*[-/:]\s*([A-Za-z0-9]{2,10})(\s*(lp|pool|vault))?$/i;

const NAME_DERIV = /\b(wrapped|bridged|liquid[- ]?(re)?stak(ed|ing)|re-?staked|staked [a-z0-9$]{2,10}|lst|lrt|receipt|vault (share|token|receipt)s?|lp tokens?|wrapper|tokenized deposits?)\b/i;
const DESC_DERIV = /(liquid (re)?staking (token|derivative|receipt)|\b(lst|lrt)\b|1:1 (backed|claim|redeemable|wrapper|representation)|redeemable 1:1|wrapped (version|representation) of|bridged (version|representation|copy) of|canonical bridge(d)? (token|asset)|receipt token|deposit receipt|erc-?4626 (vault )?shares?|tokenized vault shares?|represents? (a |your )?(share|claim) (of|on)|lp tokens? (representing|for|of)|liquidity provider tokens?)/i;
const FORK_WRAPPER = /\b(fork(ed)? of|clone of|copy of)\b.*\b(single[- ]asset|wraps?|wrapper|1:1|pegged|peg)\b|\b(single[- ]asset|wrapper)\b.*\b(fork(ed)? of|clone of)\b/i;
const DERIV_SECTORS = new Set(['liquid-staking', 'liquid-restaking']);
const DERIV_CATEGORY = /wrapped|bridged asset|receipt|synthetic wrapper|lp token/i;

export function derivativeVerdict(r: Rec): Verdict {
  const no: Verdict = { strip: false, reason: '', detail: '' };
  if (DERIV_SECTORS.has(r.sector)) return { strip: true, reason: 'derivative:category', detail: `category "${r.category}" issues staking derivatives` };
  if (DERIV_CATEGORY.test(r.category)) return { strip: true, reason: 'derivative:category', detail: `category "${r.category}"` };
  if (r.symbolRaw) {
    const sym = r.symbol;
    const folded = foldText(r.symbolRaw);
    const disguised = folded !== r.symbolRaw || /[^\x20-\x7E]/.test(r.symbolRaw);
    if (BRIDGE_SUFFIX_RAW.test(folded) && BASE_ASSETS.has(normSymbol(folded.replace(BRIDGE_SUFFIX_RAW, '')))) {
      return { strip: true, reason: 'derivative:bridged_ticker', detail: `${r.symbolRaw} -> bridged ${normSymbol(folded.replace(BRIDGE_SUFFIX_RAW, ''))}` };
    }
    const pm = PAIR_RAW.exec(folded);
    if (pm && (BASE_ASSETS.has(normSymbol(pm[1])) || BASE_ASSETS.has(normSymbol(pm[2])))) {
      return { strip: true, reason: 'derivative:lp_receipt', detail: `pair ticker ${r.symbolRaw}` };
    }
    if (LP_SYMBOL.test(sym)) return { strip: true, reason: 'derivative:lp_receipt', detail: `LP ticker ${r.symbolRaw}` };
    const base = wrapperBase(sym);
    if (base) return { strip: true, reason: disguised ? 'derivative:disguised_ticker' : 'derivative:wrapper_ticker', detail: `${JSON.stringify(r.symbolRaw)} normalizes to ${sym}, a wrapper of ${base}` };
    if (BASE_ASSETS.has(sym)) {
      const nameIsAsset = r.key === sym.toLowerCase() || /^(ethereum|bitcoin|solana)$/.test(r.key);
      if (!nameIsAsset) return { strip: true, reason: disguised ? 'derivative:disguised_ticker' : 'derivative:base_ticker_clone', detail: `ticker ${JSON.stringify(r.symbolRaw)} impersonates base asset ${sym}` };
    }
  }
  if (NAME_DERIV.test(r.name)) return { strip: true, reason: 'derivative:name_marker', detail: (NAME_DERIV.exec(r.name) as RegExpExecArray)[0] };
  if (FORK_WRAPPER.test(r.description)) return { strip: true, reason: 'derivative:fork_wrapper', detail: 'forked single-asset wrapper' };
  if (DESC_DERIV.test(r.description)) return { strip: true, reason: 'derivative:description_marker', detail: (DESC_DERIV.exec(r.description) as RegExpExecArray)[0] };
  return no;
}

// ---------------------------------------------------------------- live-token detection
const TOKEN_LINK = /(snapshot\.(org|box)|tally\.(xyz|so)|coingecko\.com\/[a-z-]*\/?coins|coinmarketcap\.com\/currencies|dexscreener\.com|geckoterminal\.com|birdeye\.so\/token|realms\.today|app\.aragon\.org|jup\.ag\/(swap|tokens?)|etherscan\.io\/token|solscan\.io\/token|basescan\.org\/token)/;
const PRE_TOKEN = /\b(no token|tokenless|pre-?token|has(n't| not) (launched|issued) a token|token (tba|tbd|not (yet )?(live|launched|issued))|yet to (launch|issue) a token|points (program|campaign|season)|retroactive (airdrop|rewards) (expected|planned|possible)|no governance token)\b/i;
const LIVE_DESC_WORDS = /\b(token (is )?(live|trading|listed|launched)|listed on (binance|coinbase|okx|bybit|kraken|upbit)|tge (completed|done|happened|took place)|airdrop (completed|distributed|claimed))\b/i;
const LIVE_DESC_TICKER = /\b([Gg]overnance|[Nn]ative|[Uu]tility) token \$?[A-Z][A-Z0-9]{1,9}\b|\b[Ss]takers of \$[A-Z]{2,}|\b[Tt]rades as \$?[A-Z]{2,}\b/;
const liveDesc = (d: string) => LIVE_DESC_WORDS.exec(d) ?? LIVE_DESC_TICKER.exec(d);

export function liveTokenVerdict(r: Rec): Verdict {
  if (r.symbolRaw && !isPlaceholderSymbol(r.symbol)) {
    return { strip: true, reason: 'live_token:symbol', detail: `live ticker ${JSON.stringify(r.symbolRaw)}` };
  }
  const link = r.links.find((l) => TOKEN_LINK.test(l));
  if (link) return { strip: true, reason: 'live_token:governance_or_market_link', detail: link };
  const m = PRE_TOKEN.test(r.description) ? null : liveDesc(r.description);
  if (m) return { strip: true, reason: 'live_token:description', detail: m[0] };
  return { strip: false, reason: '', detail: '' };
}

export function keepReasons(r: Rec): string[] {
  const out: string[] = [];
  out.push(r.symbolRaw ? `placeholder_symbol:${r.symbolRaw}` : 'no_symbol');
  if (PRE_TOKEN.test(r.description)) out.push('pre_token_signal');
  if (r.links.length) out.push('governance_links_without_token_markers');
  return out;
}

// ---------------------------------------------------------------- sector model
export interface SectorModel { tvl: number; fees: number; rev: number; steps: string[] }
// tvl = FDV/TVL multiple, fees = FDV / annualized fees, rev = FDV / annualized revenue.
const P_FUND = 'Fund a fresh wallet on {chain} with a small, capped amount (gas + test size only)';
const P_VERIFY = 'Verify the official {name} domain and contract addresses from two independent sources before signing';
const P_REVOKE = 'Revoke unused token approvals after each session';
export const SECTORS: Record<string, SectorModel> = {
  dex: { tvl: 0.9, fees: 12, rev: 32, steps: [P_VERIFY, P_FUND, 'Swap a small amount on {name} through 2+ distinct pairs', 'Provide liquidity in a major pair on {name} and keep it active for 7+ days', 'Claim accrued LP fees on {name}', 'Repeat small swaps in different weeks (activity spread beats volume)', P_REVOKE] },
  lending: { tvl: 0.55, fees: 15, rev: 38, steps: [P_VERIFY, P_FUND, 'Supply a blue-chip asset as collateral on {name}', 'Borrow a small stable amount well below liquidation threshold (health factor > 2)', 'Repay part of the loan in a later week', 'Withdraw and re-supply once to show repeat usage', P_REVOKE] },
  derivatives: { tvl: 1.4, fees: 9, rev: 24, steps: [P_VERIFY, P_FUND, 'Deposit a small margin balance on {name}', 'Open and close a low-leverage (<=2x) position', 'Place one limit order that fills', 'Provide to the LP / vault side if one exists, small size', 'Withdraw margin', P_REVOKE] },
  yield: { tvl: 0.45, fees: 14, rev: 30, steps: [P_VERIFY, P_FUND, 'Deposit into the largest audited vault on {name}', 'Hold 14+ days and harvest/compound once', 'Withdraw part of the position', P_REVOKE] },
  cdp: { tvl: 0.5, fees: 16, rev: 34, steps: [P_VERIFY, P_FUND, 'Open a CDP on {name} at a conservative collateral ratio (>250%)', 'Mint a small amount of the protocol stablecoin', 'Use the stablecoin once in its native pool', 'Repay and close or partially unwind', P_REVOKE] },
  bridge: { tvl: 1.1, fees: 20, rev: 40, steps: [P_VERIFY, P_FUND, 'Bridge a small amount from {chain} to a second chain via {name}', 'Bridge back on a different route / asset', 'Repeat in a different week', P_REVOKE] },
  restaking: { tvl: 0.6, fees: 18, rev: 36, steps: [P_VERIFY, P_FUND, 'Restake a small amount of the native asset on {name}', 'Delegate to an operator with public track record', 'Hold through at least one reward epoch', P_REVOKE] },
  launchpad: { tvl: 1.2, fees: 8, rev: 18, steps: [P_VERIFY, P_FUND, 'Complete the free on-chain profile / registration on {name}', 'Participate in one sale or pool with minimal size', 'Claim or refund on-chain', P_REVOKE] },
  nft: { tvl: 1.5, fees: 10, rev: 22, steps: [P_VERIFY, P_FUND, 'List or bid on a low-value item on {name}', 'Complete one trade', 'Cancel an outstanding listing (cheap on-chain action)', P_REVOKE] },
  gaming: { tvl: 2.0, fees: 10, rev: 20, steps: [P_FUND, 'Create the on-chain game account for {name}', 'Complete the on-chain onboarding quest', 'Make one in-game on-chain transaction', P_REVOKE] },
  rwa: { tvl: 0.35, fees: 18, rev: 40, steps: [P_VERIFY, 'Check whether {name} requires KYC; skip if it does', P_FUND, 'Deposit a small amount into a permissionless pool', 'Hold through one distribution and claim', P_REVOKE] },
  insurance: { tvl: 0.8, fees: 15, rev: 30, steps: [P_VERIFY, P_FUND, 'Buy a minimal cover policy on {name}', 'Stake a small amount on the underwriting side', P_REVOKE] },
  oracle: { tvl: 2.5, fees: 20, rev: 40, steps: [P_VERIFY, P_FUND, 'Use a dApp consuming {name} feeds on {chain}', 'Interact with the {name} on-chain request/update flow once', P_REVOKE] },
  prediction: { tvl: 1.6, fees: 10, rev: 22, steps: [P_VERIFY, P_FUND, 'Place a small position on a liquid market on {name}', 'Exit before resolution in one market, hold to resolution in another', 'Redeem winnings', P_REVOKE] },
  payments: { tvl: 1.5, fees: 15, rev: 30, steps: [P_VERIFY, P_FUND, 'Send a small on-chain payment through {name}', 'Receive one payment / create a payment link', P_REVOKE] },
  social: { tvl: 2.0, fees: 10, rev: 20, steps: [P_FUND, 'Create the on-chain profile on {name}', 'Post / interact on-chain a few times across weeks', P_REVOKE] },
  privacy: { tvl: 0.8, fees: 15, rev: 30, steps: [P_VERIFY, 'Check legal status of {name} in your jurisdiction first', P_FUND, P_REVOKE] },
  infrastructure: { tvl: 1.8, fees: 18, rev: 36, steps: [P_VERIFY, P_FUND, 'Use the {name} service on {chain} for a real on-chain action', 'Repeat in a later week', P_REVOKE] },
  'liquid-staking': { tvl: 0.4, fees: 14, rev: 30, steps: [P_VERIFY, P_FUND, 'Stake a small amount', P_REVOKE] },
  'liquid-restaking': { tvl: 0.4, fees: 14, rev: 30, steps: [P_VERIFY, P_FUND, 'Restake a small amount', P_REVOKE] },
  other: { tvl: 1.0, fees: 14, rev: 30, steps: [P_VERIFY, P_FUND, 'Use the core on-chain feature of {name} once with small size', 'Repeat in a later week', P_REVOKE] },
};

export const WEIGHTS = { tvl: 0.4, fees: 0.3, rev: 0.3 };
export const CLAMP = {
  weeklyGrowthCredit: 1.0,  // at most +100%/7d of TVL growth is credited
  madK: 3.0,                // log10(TVL) cap = sector median + K * 1.4826 * MAD
  minSigma: 0.25,           // decades; floor for the robust sigma
  minSectorSize: 5,         // below this, the global distribution is used
  minFeeYield: 0.0005,      // annual fees / TVL below this + above-median TVL => fee-starved wash TVL
  maxFeeYield: 5.0,         // annual fees above 500% of TVL are clamped (wash volume)
};

export function playbook(r: { name: string; sector: string; primaryChain: string }): string[] {
  const m = SECTORS[r.sector] ?? SECTORS.other;
  const steps = m.steps.map((s) => s.replace(/\{name\}/g, r.name).replace(/\{chain\}/g, r.primaryChain || 'its main chain'));
  while (steps.length < 3) steps.push(P_REVOKE);
  return steps.slice(0, 8);
}

// ---------------------------------------------------------------- pipeline
export interface Options { maxRows?: number; minRows?: number; includeStripped?: boolean }

interface Fam { rep: Rec; members: Rec[]; parentName: string; tvl: number; fees: number; revenue: number; delta: number | null; chains: string[]; rule: string }

export function rank(input: unknown, opts: Options = {}) {
  const maxRows = Math.min(opts.maxRows ?? MAX_ROWS, MAX_ROWS);
  const list: unknown[] = Array.isArray(input) ? input : (input && typeof input === 'object' && Array.isArray((input as any).protocols)) ? (input as any).protocols : [];
  // 0. canonical order => input-order independence
  const recs = list.map((x) => normalize(x as RawRecord)).sort((a, b) => cmp(a.key, b.key) || cmp(a.canon, b.canon));
  recs.forEach((r, i) => { r.idx = i; });
  const stripped: Strip[] = [];
  const strip = (r: Rec, reason: string, detail: string) => stripped.push({ name: r.name || '(unnamed)', key: r.key, reason, detail });

  // 1. invalid
  const valid: Rec[] = [];
  for (const r of recs) {
    if (!r.key) strip(r, 'invalid:missing_name', 'name empty after normalization');
    else if (r.tvl === null || r.tvl <= 0) strip(r, 'invalid:missing_or_nonpositive_tvl', r.notes.filter((n) => n.includes('tvl')).join(',') || 'tvl_usd <= 0');
    else valid.push(r);
  }
  // 2. exact duplicates by normalized name: keep max TVL, then canonical JSON
  const byKey = new Map<string, Rec[]>();
  for (const r of valid) { const g = byKey.get(r.key); if (g) g.push(r); else byKey.set(r.key, [r]); }
  const uniq: Rec[] = [];
  for (const [, g] of [...byKey].sort((a, b) => cmp(a[0], b[0]))) {
    g.sort((a, b) => (b.tvl as number) - (a.tvl as number) || cmp(a.canon, b.canon));
    uniq.push(g[0]);
    for (const d of g.slice(1)) strip(d, 'duplicate:same_name', `kept the higher-TVL copy of ${g[0].name}`);
  }
  const index = new Map(uniq.map((r) => [r.key, r] as [string, Rec]));
  // 3. per-record verdicts
  const verdict = new Map<string, Verdict>();
  for (const r of uniq) {
    const d = derivativeVerdict(r);
    verdict.set(r.key, d.strip ? d : liveTokenVerdict(r));
  }
  // 4. family roots (cycle safe) + inheritance
  const rootOf = (r: Rec): { root: string; chain: string[] } => {
    const seen: string[] = [r.key];
    let cur = r.parentKey;
    while (cur && !seen.includes(cur)) {
      seen.push(cur);
      const p = index.get(cur);
      if (!p || !p.parentKey) break;
      cur = p.parentKey;
    }
    if (cur && seen.indexOf(cur) < seen.length - 1) { // cycle: pick smallest key in the cycle
      const cyc = seen.slice(seen.indexOf(cur)).sort(cmp);
      return { root: cyc[0], chain: seen };
    }
    return { root: seen[seen.length - 1], chain: seen };
  };
  const families = new Map<string, Rec[]>();
  for (const r of uniq) {
    const v = verdict.get(r.key) as Verdict;
    if (v.strip) { strip(r, v.reason, v.detail); continue; }
    const { root, chain } = rootOf(r);
    const taintedBy = chain.slice(1).map((k) => index.get(k)).find((p) => p && (verdict.get(p.key) as Verdict).strip);
    if (taintedBy) {
      const pv = verdict.get(taintedBy.key) as Verdict;
      const kind = pv.reason.split(':')[0];
      strip(r, `${kind}:inherited_from_parent`, `ancestor ${taintedBy.name} stripped (${pv.reason})`);
      continue;
    }
    const g = families.get(root); if (g) g.push(r); else families.set(root, [r]);
  }
  // 5. collapse families => one row, never parent + child TVL
  const fams: Fam[] = [];
  for (const [root, members] of [...families].sort((a, b) => cmp(a[0], b[0]))) {
    members.sort((a, b) => cmp(a.key, b.key));
    const rootRec = members.find((m) => m.key === root);
    const kids = members.filter((m) => m !== rootRec);
    const sum = (xs: Rec[], f: (r: Rec) => number) => xs.reduce((s, x) => s + f(x), 0);
    let rep: Rec, tvl: number, fees: number, revenue: number, rule: string;
    if (rootRec) {
      rep = rootRec;
      const kt = sum(kids, (x) => x.tvl as number);
      tvl = Math.max(rootRec.tvl as number, kt);
      fees = Math.max(rootRec.fees ?? 0, sum(kids, (x) => x.fees ?? 0));
      revenue = Math.max(rootRec.revenue ?? 0, sum(kids, (x) => x.revenue ?? 0));
      rule = kids.length ? 'max(parent, sum(children))' : 'single';
    } else {
      rep = members.slice().sort((a, b) => (b.tvl as number) - (a.tvl as number) || cmp(a.key, b.key))[0];
      tvl = sum(members, (x) => x.tvl as number);
      fees = sum(members, (x) => x.fees ?? 0);
      revenue = sum(members, (x) => x.revenue ?? 0);
      rule = members.length > 1 ? 'sum(sibling modules; parent record absent)' : 'single';
    }
    const parentName = rootRec ? rootRec.name : (rep.parentRaw ? foldText(rep.parentRaw) : rep.name);
    for (const m of members) if (m !== rep) strip(m, 'dedupe:merged_into_family', `counted once inside ${parentName}`);
    const deltas = members.filter((m) => m.delta !== null);
    const delta = deltas.length ? sum(deltas, (m) => (m.delta as number) * (m.tvl as number)) / sum(deltas, (m) => m.tvl as number) : null;
    const chains = [...new Set(members.flatMap((m) => m.chains))].sort(cmp);
    fams.push({ rep, members, parentName, tvl, fees, revenue, delta, chains, rule });
  }
  // 6. wash clamps (all statistics over sorted arrays => order independent)
  const pre = fams.map((f) => {
    const flags: string[] = [];
    let t = f.tvl;
    if (f.delta !== null && f.delta > CLAMP.weeklyGrowthCredit) {
      t = (t / (1 + f.delta)) * (1 + CLAMP.weeklyGrowthCredit);
      flags.push(`tvl_spike_haircut(7d ${round(f.delta * 100, 1)}%)`);
    }
    return { f, t, flags };
  });
  const sectorLogs = new Map<string, number[]>();
  for (const p of pre) { const s = p.f.rep.sector; const a = sectorLogs.get(s); const v = Math.log10(p.t); if (a) a.push(v); else sectorLogs.set(s, [v]); }
  const globalLogs = pre.map((p) => Math.log10(p.t));
  const stat = (xs: number[]) => { const med = median(xs); const mad = median(xs.map((x) => Math.abs(x - med))); return { med, sigma: Math.max(CLAMP.minSigma, 1.4826 * mad), n: xs.length }; };
  const gStat = stat(globalLogs);
  const sStat = new Map<string, { med: number; sigma: number; n: number }>();
  for (const [s, xs] of sectorLogs) sStat.set(s, xs.length >= CLAMP.minSectorSize ? stat(xs) : { ...gStat, n: xs.length });
  const sectorMedianTvl = (s: string) => 10 ** (sStat.get(s) as { med: number }).med;

  const rows = pre.map(({ f, t, flags }) => {
    const r = f.rep;
    const st = sStat.get(r.sector) as { med: number; sigma: number; n: number };
    const cap = 10 ** (st.med + CLAMP.madK * st.sigma);
    if (t > cap) { flags.push(`sector_mad_clamp(cap ${Math.round(cap)})`); t = cap; }
    let annFees = f.fees * 12;
    let annRev = f.revenue * 12;
    const med = sectorMedianTvl(r.sector);
    if (t > med && annFees / t < CLAMP.minFeeYield) {
      const t2 = Math.max(med, annFees / CLAMP.minFeeYield);
      if (t2 < t) { flags.push('fee_starved_tvl_clamp'); t = t2; }
    }
    if (annFees > CLAMP.maxFeeYield * t) { const c = CLAMP.maxFeeYield * t; annRev = Math.min(annRev, c); annFees = c; flags.push('fee_spike_clamp'); }
    const m = SECTORS[r.sector] ?? SECTORS.other;
    const comps: { k: 'tvl' | 'fees' | 'rev'; v: number }[] = [];
    comps.push({ k: 'tvl', v: t * m.tvl });
    if (annFees > 0) comps.push({ k: 'fees', v: annFees * m.fees });
    if (annRev > 0) comps.push({ k: 'rev', v: annRev * m.rev });
    const wsum = comps.reduce((s, c) => s + WEIGHTS[c.k], 0);
    const logMid = comps.reduce((s, c) => s + WEIGHTS[c.k] * Math.log(c.v), 0) / wsum;
    const disp = Math.sqrt(comps.reduce((s, c) => s + WEIGHTS[c.k] * (Math.log(c.v) - logMid) ** 2, 0) / wsum);
    const momentum = 1 + 0.5 * Math.max(-0.2, Math.min(0.2, f.delta ?? 0));
    const mid = Math.exp(logMid) * momentum;
    const spread = Math.max(0.35, disp) + (flags.length ? 0.15 : 0) + (comps.length < 3 ? 0.15 : 0);
    const confidence = comps.length === 3 && flags.length === 0 && disp < 0.7 ? 'high' : comps.length >= 2 && flags.length <= 1 ? 'medium' : 'low';
    const primaryChain = f.chains[0] ?? '';
    return {
      rank: 0,
      name: f.members.length > 1 && !f.members.some((x) => x.key === f.rep.key && !x.parentKey) ? f.parentName : r.name,
      key: r.key,
      category: r.category,
      sector: r.sector,
      chains: f.chains,
      fdv_usd: { low: Math.round(mid * Math.exp(-spread)), mid: Math.round(mid), high: Math.round(mid * Math.exp(spread)) },
      fdv_components_usd: Object.fromEntries(comps.map((c) => [c.k, Math.round(c.v)])),
      multiples: { fdv_to_tvl: m.tvl, fdv_to_annual_fees: m.fees, fdv_to_annual_revenue: m.rev },
      tvl_usd: round(f.tvl, 2),
      tvl_effective_usd: round(t, 2),
      tvl_7d_delta: f.delta === null ? null : round(f.delta, 4),
      fees_annualized_usd: round(annFees, 2),
      revenue_annualized_usd: round(annRev, 2),
      revenue_to_tvl: round(annRev / t, 6),
      sector_median_tvl_usd: round(med, 2),
      clamp_flags: flags,
      confidence,
      keep_reasons: keepReasons(r),
      input_notes: [...new Set(f.members.flatMap((x) => x.notes))].sort(cmp),
      family: { parent: f.parentName, members: f.members.map((x) => x.name), tvl_rule: f.rule },
      playbook: playbook({ name: r.name, sector: r.sector, primaryChain }),
    };
  });
  rows.sort((a, b) => b.fdv_usd.mid - a.fdv_usd.mid || cmp(a.key, b.key));
  const out = rows.slice(0, maxRows);
  out.forEach((r, i) => { r.rank = i + 1; });
  stripped.sort((a, b) => cmp(a.key, b.key) || cmp(a.reason, b.reason) || cmp(a.detail, b.detail));
  const counts: Record<string, number> = {};
  for (const s of stripped) { const k = s.reason.split(':')[0]; counts[k] = (counts[k] ?? 0) + 1; }
  const reasons: Record<string, number> = {};
  for (const s of stripped) reasons[s.reason] = (reasons[s.reason] ?? 0) + 1;
  const board = {
    schema: SCHEMA,
    input: { records: list.length, sha256_canonical: sha256(recs.map((r) => r.canon).join('\n')) },
    params: { weights: WEIGHTS, clamp: CLAMP, max_rows: maxRows },
    summary: {
      input_records: list.length,
      stripped_total: stripped.length,
      stripped_by_class: Object.fromEntries(Object.entries(counts).sort((a, b) => cmp(a[0], b[0]))),
      stripped_by_reason: Object.fromEntries(Object.entries(reasons).sort((a, b) => cmp(a[0], b[0]))),
      families_ranked: rows.length,
      rows_emitted: out.length,
      truncated: rows.length - out.length,
    },
    rows: out,
    stripped: opts.includeStripped === false ? [] : stripped,
  };
  return board;
}

export function serialize(board: unknown): string { return JSON.stringify(board, null, 2) + '\n'; }

// ---------------------------------------------------------------- seeded synthetic corpus
export function seedHash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function generateCorpus(count: number, seed = 't22'): RawRecord[] {
  const rnd = mulberry32(seedHash(seed));
  const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];
  const logu = (lo: number, hi: number) => 10 ** (lo + rnd() * (hi - lo));
  const syl = ['ka', 'zen', 'lo', 'vor', 'mi', 'tra', 'nex', 'sol', 'qua', 'ri', 'dax', 'pho', 'lum', 'ter', 'vex', 'ora', 'syn', 'bel', 'cri', 'mon', 'hal', 'ix', 'pra', 'tel'];
  const cats = ['Dexes', 'Lending', 'Derivatives', 'Yield', 'CDP', 'Bridge', 'Launchpad', 'NFT Marketplace', 'Gaming', 'RWA', 'Insurance', 'Oracle', 'Prediction Market', 'Payments', 'SocialFi', 'Infrastructure', 'Restaking'];
  const chainsAll = ['Solana', 'Ethereum', 'Base', 'Arbitrum', 'Optimism', 'BSC', 'Sui', 'Aptos', 'Avalanche', 'Polygon', 'Sonic', 'Berachain', 'Hyperliquid L1'];
  let serial = 0;
  const mkName = () => { serial++; const n = pick(syl) + pick(syl) + (rnd() < 0.5 ? pick(syl) : ''); return n[0].toUpperCase() + n.slice(1) + ' ' + serial.toString(36).toUpperCase(); };
  const chains = () => { const k = 1 + Math.floor(rnd() * 3); const s = new Set<string>(); while (s.size < k) s.add(pick(chainsAll)); return [...s]; };
  const base = (over: RawRecord = {}): RawRecord => {
    const tvl = logu(5, 9.3);
    const fy = logu(-3, -0.7); // annual fee yield
    const fees = (tvl * fy) / 12;
    return {
      name: mkName(), category: pick(cats), chains: chains(), tvl_usd: Math.round(tvl), tvl_7d_delta: round(rnd() * 0.5 - 0.2, 4),
      fees_30d_usd: Math.round(fees), revenue_30d_usd: Math.round(fees * (0.1 + rnd() * 0.5)), symbol: pick(['', '', 'TBA', '-', 'N/A']),
      parent_protocol: '', governance_links: rnd() < 0.3 ? ['https://forum.example.org/t/' + serial] : [],
      description: pick(['Permissionless protocol, no token yet; points program live.', 'Pre-token protocol with on-chain usage.', 'Open-source protocol. Token TBA.', 'Non-custodial app with retroactive rewards expected.']),
      ...over,
    };
  };
  const derivSyms = ['wETH', 'stETH', 'wstETH', 'jitoSOL', 'mSOL', 'bSOL', 'rsETH', 'ezETH', 'weETH', 'cbBTC', 'WBTC', 'USDC.e', 'sUSDe', 'sfrxETH', 'PT-weETH', 'aUSDC', 'yvUSDC', 'mooBNB', 'ETH-USDC LP', 'stSOL', 'ankrETH', 'pufETH', 'rETH', 'JupSOL', 'hSOL',
    'w\u0395TH', '\uFF4A\uFF49\uFF54\uFF4F\uFF33\uFF2F\uFF2C', 'st\u200BETH', 'ws\u0442ETH', '$\u0455OL', 'W-ETH', 'st.ETH', 'USDT.wh', 'SOL_axl'];
  const derivNames = ['Wrapped Staked {x}', 'Bridged {x}', 'Liquid Staking {x}', 'Restaked {x} Pool', '{x} Vault Shares', '{x} LP Token'];
  const out: RawRecord[] = [];
  const tokenParents: string[] = [];
  const pretokenParents: string[] = [];
  while (out.length < count) {
    const u = rnd();
    if (u < 0.38) { // pre-token base
      const r = base(); out.push(r); if (rnd() < 0.12) pretokenParents.push(r.name as string);
    } else if (u < 0.55) { // live token (symbol, link or description)
      const v = rnd();
      const r = base(v < 0.6 ? { symbol: (pick(syl) + pick(syl)).toUpperCase().slice(0, 5) } : v < 0.85 ? { governance_links: [pick(['https://snapshot.org/#/', 'https://www.tally.xyz/gov/', 'https://www.coingecko.com/en/coins/']) + serial] } : { description: 'Governance token ' + (pick(syl) + pick(syl)).toUpperCase() + ' is live and trading on major venues.' });
      out.push(r); if (rnd() < 0.15) tokenParents.push(r.name as string);
    } else if (u < 0.74) { // derivative wrappers
      const v = rnd();
      if (v < 0.55) out.push(base({ symbol: pick(derivSyms), category: pick(['Yield', 'Dexes', 'Lending', 'Bridge']) }));
      else if (v < 0.75) out.push(base({ name: pick(derivNames).replace('{x}', pick(['ETH', 'SOL', 'BTC', 'USDC'])) + ' ' + (++serial).toString(36), symbol: '' }));
      else if (v < 0.88) out.push(base({ category: pick(['Liquid Staking', 'Liquid Restaking']) }));
      else if (v < 0.95) out.push(base({ description: pick(['Liquid staking token redeemable 1:1 for the underlying.', 'ERC-4626 vault shares for a USDC strategy.', 'Bridged version of the canonical asset.', 'Receipt token for deposits.']) }));
      else out.push(base({ description: 'A fork of a popular protocol that wraps a single asset 1:1.' }));
    } else if (u < 0.88) { // children modules
      if (pretokenParents.length && rnd() < 0.6) { const p = pick(pretokenParents); out.push(base({ parent_protocol: p, name: p + ' ' + pick(['V2', 'V3', 'Lend', 'Perps', 'Pools']) + ' ' + (++serial).toString(36) })); }
      else if (tokenParents.length) { const p = pick(tokenParents); out.push(base({ parent_protocol: p, name: p + ' ' + pick(['V2', 'Earn', 'Pro']) + ' ' + (++serial).toString(36) })); }
      else out.push(base({ parent_protocol: 'Ghost Parent ' + Math.floor(rnd() * 20) }));
    } else if (u < 0.93) { // wash TVL
      const v = rnd();
      out.push(base(v < 0.4 ? { tvl_usd: Math.round(logu(10.5, 12)), fees_30d_usd: Math.round(logu(1, 3)), revenue_30d_usd: 0 } : v < 0.75 ? { tvl_7d_delta: round(5 + rnd() * 40, 2) } : { tvl_usd: Math.round(logu(4, 5)), fees_30d_usd: Math.round(logu(7, 8)) }));
    } else if (u < 0.97) { // junk / NaN / missing fields
      const v = rnd();
      out.push(base(v < 0.25 ? { tvl_usd: 'NaN' } : v < 0.45 ? { name: '' } : v < 0.6 ? { tvl_usd: -5 } : v < 0.75 ? { fees_30d_usd: null, revenue_30d_usd: 'n/a' } : v < 0.9 ? { tvl_usd: '$12.5M', chains: 'Solana, Base' } : { category: undefined, chains: null }));
    } else if (out.length) { // duplicate with tweaks
      const src = out[Math.floor(rnd() * out.length)];
      out.push({ ...src, tvl_usd: typeof src.tvl_usd === 'number' ? Math.round((src.tvl_usd as number) * (0.5 + rnd())) : src.tvl_usd });
    }
  }
  return out;
}

// ---------------------------------------------------------------- CLI
function arg(argv: string[], flag: string): string | undefined { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; }

export function main(argv: string[]): number {
  const cmd = argv[0] && !argv[0].startsWith('--') ? argv[0] : argv.includes('--generate-synthetic') ? 'demo' : 'rank';
  const seed = arg(argv, '--seed') ?? 't22';
  const outPath = arg(argv, '--out') ?? arg(argv, '--output') ?? 'board.json';
  if (cmd === 'help' || argv.includes('--help')) {
    process.stdout.write('usage:\n  node ranker.ts rank --in snapshot.json [--out board.json] [--max-rows 4000] [--min-rows 100] [--no-stripped]\n  node ranker.ts gen --count 4200 [--seed t22] --out corpus.json\n  node ranker.ts --generate-synthetic 4200 [--seed t22] [--out board.json] [--emit-corpus corpus.json]\n');
    return 0;
  }
  if (cmd === 'gen') {
    const n = Number(arg(argv, '--count') ?? 4200);
    const corpus = generateCorpus(n, seed);
    writeFileSync(arg(argv, '--out') ?? 'corpus.json', JSON.stringify(corpus, null, 1) + '\n');
    process.stderr.write(`generated ${corpus.length} records (seed=${seed})\n`);
    return 0;
  }
  let data: unknown;
  if (cmd === 'demo') {
    data = generateCorpus(Number(arg(argv, '--generate-synthetic') ?? 4200), seed);
    const ec = arg(argv, '--emit-corpus'); if (ec) writeFileSync(ec, JSON.stringify(data, null, 1) + '\n');
  } else {
    const inPath = arg(argv, '--in') ?? arg(argv, '--input');
    if (!inPath) { process.stderr.write('error: --in <snapshot.json> required (or --generate-synthetic N)\n'); return 2; }
    try { data = JSON.parse(readFileSync(inPath, 'utf8')); } catch (e) { process.stderr.write(`error: cannot read ${inPath}: ${(e as Error).message}\n`); return 2; }
  }
  const minRows = Number(arg(argv, '--min-rows') ?? MIN_ROWS);
  const board = rank(data, { maxRows: Number(arg(argv, '--max-rows') ?? MAX_ROWS), includeStripped: !argv.includes('--no-stripped') });
  const text = serialize(board);
  writeFileSync(outPath, text);
  const n = board.rows.length;
  process.stderr.write(`input=${board.summary.input_records} stripped=${board.summary.stripped_total} rows=${n} sha256=${sha256(text)} -> ${outPath}\n`);
  if (n < minRows) { process.stderr.write(`error: only ${n} rows (< ${minRows}); board contract is ${MIN_ROWS}..${MAX_ROWS}\n`); return 3; }
  return 0;
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invoked) process.exitCode = main(process.argv.slice(2));
