// The token radar's model, radar-2: one snapshot of the protocol universe in, one ranked board out.
//
// The board covers every slug in the snapshot's watchlist (the floor, never a ceiling) and adds
// every pre-token protocol below the floor that the watchlist's own exclusion rule would keep: no
// wrapped, staked or bridged product of a token that already trades, no exchange, no versioned pool.
// A protocol is pre-token when its index entry records no token (no market cap, no CoinGecko id, no
// symbol); the snapshot's live-token protocols are kept apart and shown as the market's own values,
// never mixed into the ranked board. Say a protocol records no token, never that it has none.
//
// Implied value follows only from the snapshot's own figures, and the base multiple is calibrated
// from them too: calibrateMultiple takes the median market-cap-to-TVL ratio across the snapshot's
// live-token protocols (ratios outside 0.005..5 are discarded as outliers), so the multiple is the
// market's own, not a hand-picked constant. On this snapshot it comes out near 0.20.
//
//   base       = tvl_usd x calibrated multiple
//   growth     = clamp(change_7d, -60, 120) per cent
//   growthMult = 1 + (growth / 100) x GROWTH_WEIGHT
//   maturity   = 0.6 + min(age_days, 1095) / 1095 x 0.4
//   breadth    = 1 + 0.05 x min(chains - 1, 4), capped at 1.20
//   implied    = max(1, round(base x growthMult x maturity x breadth))
//
// Age is the time since DefiLlama first listed the protocol, the best record of how long it has run
// with no token. A protocol with no listed date takes its category's median age from the snapshot,
// and a category with no listed dates takes the snapshot's global median age: the fallback is data,
// never a magic number. No protocol name is ever special-cased: the same function scores every row.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's constants, as the dashboard states them and the sandbox may change them. */
export interface ModelConstants {
  base_multiple: number;
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  breadth_step: number;
  breadth_cap: number;
}

export const MODEL: ModelConstants = {
  base_multiple: 0.2,
  growth_weight: 0.5,
  growth_floor: -60,
  growth_cap: 120,
  maturity_floor: 0.6,
  maturity_range: 0.4,
  maturity_days: 1095,
  breadth_step: 0.05,
  breadth_cap: 4,
};

/** The model's version label: the dashboard names it and the rules quote it. */
export const MODEL_VERSION = 'radar-2';

/** How many live-token protocols the Live token view carries, by market cap. */
export const LIVE_ROWS = 24;

/** The band a live-token mcap/TVL ratio must sit in to count toward the calibration. */
export const CALIBRATION_BAND = { lo: 0.005, hi: 5 };

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  age_used_days: number;
  implied_value_usd: number;
  model: {
    base_multiple: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    breadth_multiplier: number;
    age_days: number;
  };
  farm_steps: string[];
}

/** The dashboard's compact view of one row, with farm plans generated in the page. */
export interface RadarRow {
  rank: number;
  watchlist: boolean;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  age_used_days: number;
  implied_value_usd: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  breadth_multiplier: number;
}

/** A live-token protocol: it already trades, so the board shows the market's own value, not a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** Everything the dashboard needs: the board, the live set, and the model it runs. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  calibration_n: number;
  calibration_band: { lo: number; hi: number };
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: RadarRow[];
  live: LiveRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** The median of a non-empty list of numbers; NaN when empty. */
export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length === 0) return NaN;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** The median age in days of every category with a listed date, plus the global median. */
export function ageMedians(snapshot: Snapshot): { byCategory: Map<string, number>; global: number } {
  const byCategory = new Map<string, number[]>();
  const all: number[] = [];
  for (const p of snapshot.protocols) {
    const age = ageDays(snapshot.as_of, p.listed_at);
    if (age === null) continue;
    all.push(age);
    const key = p.category ?? 'Other';
    const list = byCategory.get(key) ?? [];
    list.push(age);
    byCategory.set(key, list);
  }
  const medians = new Map<string, number>();
  for (const [key, list] of byCategory) medians.set(key, Math.round(median(list)));
  return { byCategory: medians, global: Math.round(median(all)) };
}

/**
 * The base multiple, calibrated from the snapshot itself: the median market-cap-to-TVL ratio across
 * the snapshot's live-token protocols, ratios outside the band discarded as outliers (a token with a
 * $2.6B market cap on $6.6M of TVL is a listing, not a valuation). Returns the multiple and how many
 * protocols calibrated it. Falls back to 0.2 when the snapshot carries no usable ratio.
 */
export function calibrateMultiple(snapshot: Snapshot): { multiple: number; n: number } {
  const ratios: number[] = [];
  for (const p of snapshot.protocols) {
    if (p.mcap_usd === null || p.tvl_usd <= 0) continue;
    const ratio = p.mcap_usd / p.tvl_usd;
    if (ratio >= CALIBRATION_BAND.lo && ratio <= CALIBRATION_BAND.hi) ratios.push(ratio);
  }
  if (ratios.length === 0) return { multiple: 0.2, n: 0 };
  return { multiple: Math.round(median(ratios) * 10000) / 10000, n: ratios.length };
}

/** The three multipliers and the implied value one protocol gets under `model`. */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  model: ModelConstants,
  ages: { byCategory: Map<string, number>; global: number },
): { implied: number; growthPct: number; growthMult: number; maturityMult: number; breadthMult: number; age: number | null; ageUsed: number } {
  const age = ageDays(asOf, protocol.listed_at);
  const ageUsed = age ?? ages.byCategory.get(protocol.category ?? 'Other') ?? ages.global;
  const rawGrowth = finite(protocol.change_7d, 0);
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, rawGrowth));
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const maturityMult = model.maturity_floor + (Math.min(Math.max(ageUsed, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
  const breadthMult = 1 + model.breadth_step * Math.min(Math.max(protocol.chains.length - 1, 0), model.breadth_cap);
  const base = protocol.tvl_usd * model.base_multiple;
  const implied = Math.max(1, Math.round(base * growthMult * maturityMult * breadthMult));
  return { implied, growthPct, growthMult, maturityMult, breadthMult, age, ageUsed };
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** An exchange's name at the start of a protocol's name: a product of the exchange, not a launch. */
const EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/i;

/** Categories the watchlist's own rule keeps out: wrapped, staked or bridged products, and exchanges. */
const EXCLUDED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/**
 * Whether a protocol is one the board may rank: pre-token, and passing the same exclusion the
 * watchlist applies — not a wrapped, staked or bridged product, not an exchange, not a versioned
 * pool, not an exchange's own product. The watchlist's rows are always rankable; this rule decides
 * the early rows below the floor.
 */
export function isRankable(p: SnapshotProtocol): boolean {
  if (!isPreToken(p)) return false;
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return false;
  if (VERSIONED.test(p.name)) return false;
  if (EXCHANGE_PREFIX.test(p.name)) return false;
  return true;
}

/** The snapshot's protocol by slug. */
function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; calibration: { multiple: number; n: number } } {
  const calibrated = calibrateMultiple(snapshot);
  const effective: ModelConstants = { ...model, base_multiple: calibrated.multiple };
  const ages = ageMedians(snapshot);
  const index = bySlug(snapshot.protocols);
  const chosen = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug, even one the snapshot no longer carries (it cannot, but
  // the board's coverage is the gate's row and is never gambled on a missing record).
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The early radar: every rankable pre-token protocol below the watchlist floor. Never a
  // replacement for a watchlist row: a chosen protocol stays chosen.
  for (const p of snapshot.protocols) {
    if (!chosen.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd) chosen.set(p.slug, p);
  }

  const scored = [...chosen.values()].map((p) => {
    const v = impliedValue(p, snapshot.as_of, effective, ages);
    return { p, ...v };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  const board = scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token' as const,
    age_days: s.age,
    age_used_days: s.ageUsed,
    implied_value_usd: s.implied,
    model: {
      base_multiple: effective.base_multiple,
      growth_pct: s.growthPct,
      growth_multiplier: round4(s.growthMult),
      maturity_multiplier: round4(s.maturityMult),
      breadth_multiplier: round4(s.breadthMult),
      age_days: s.ageUsed,
    },
    farm_steps: farmSteps(s.p, s.age).map(stepText),
  }));
  return { board, calibration: calibrated };
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** What one transaction costs on a chain, in whole dollars: mainnet is dear, L2s and alt-L1s are cheap. */
function gasFor(chain: string): number {
  const c = chain.toLowerCase();
  if (c === 'ethereum') return 8;
  if (c === 'solana') return 1;
  if (c === 'tron' || c === 'bitcoin' || c === 'bittensor') return 2;
  return 1;
}

/**
 * One farm action per category, drafted for this radar and filled in with the protocol's own name,
 * chain and capital. Placeholders: {name} the protocol, {chain} its first chain, {capital} the
 * dollars. Keys are matched longest-first against the category's lowercase name, so "yield
 * aggregator" wins over "yield" and "liquid staking" over "staking".
 */
const ACTIONS: [string, string][] = [
  ['risk curator', 'Deposit ${capital} into a {name} curated vault on {chain} for 7 days; cap fees at $5.'],
  ['onchain capital allocator', 'Supply ${capital} to a {name} allocation vault on {chain} for 7 days; cap fees at $5.'],
  ['collateral market', 'Supply ${capital} as collateral to {name} on {chain} without borrowing for 7 days; cap fees at $5.'],
  ['uncollateralized lending', 'If eligible, lend ${capital} to a {name} pool on {chain} for its shortest term; cap entry fees at $5.'],
  ['leveraged farming', 'Supply ${capital} to {name} on {chain} at its lowest leverage for 1 day, then unwind; cap fees at $10.'],
  ['liquidity manager', 'Deposit ${capital} into a {name} managed LP vault on {chain} for 7 days; cap fees at $5.'],
  ['yield aggregator', 'Deposit ${capital} into a {name} auto-compounding vault on {chain} for 7 days; cap fees at $5.'],
  ['basis trading', 'Deposit ${capital} into a {name} hedged basis vault on {chain} for 7 days; cap fees at $5.'],
  ['liquid staking', 'Stake ${capital} through {name} on {chain} and hold the receipt token 7 days; cap fees at $5.'],
  ['liquid restaking', 'Restake ${capital} through {name} on {chain} for 7 days plus its exit delay; cap fees at $5.'],
  ['restaking', 'Restake ${capital} through {name} on {chain} for 7 days plus its exit delay; cap fees at $5.'],
  ['staking pool', 'Stake ${capital} of a supported asset with {name} on {chain} for 7 days plus any exit queue; cap fees at $5.'],
  ['dex aggregator', 'Route a ${capital} stablecoin swap through {name} on {chain}; allow 10 minutes and cap fees plus slippage at $5.'],
  ['prediction market', 'Buy up to ${capital} of shares in one {name} market on {chain} settling within 7 days; cap fees at $5.'],
  ['nft lending', 'Lend ${capital} against one NFT through {name} on {chain} for a term of 7 days or less; cap fees at $5.'],
  ['algo-stable', 'Swap up to ${capital} into the {name} stablecoin on {chain}, then exit after 1 day; cap fees plus slippage at $5.'],
  ['reserve currency', 'If available, stake ${capital} of the reserve asset in {name} on {chain} for 7 days; cap fees at $5.'],
  ['anchor btc', 'If supported, deposit ${capital} of wrapped BTC into {name} on {chain} for 7 days; cap fees at $5.'],
  ['cross chain', 'Bridge ${capital} from {chain} via {name} to a supported destination; allow 30 minutes and cap total fees at $10.'],
  ['cdp', 'Lock ${capital} on {chain} in {name}, borrow at under 25% LTV, then repay after 1 day; cap fees at $10.'],
  ['dex', 'Swap ${capital} of stablecoins through {name} on {chain}; allow 10 minutes and cap fees plus slippage at $5.'],
  ['rwa', 'If eligible, subscribe ${capital} to a {name} asset on {chain} for its minimum term; allow 30 minutes and cap entry fees at $5.'],
  ['payment', 'Send ${capital} through {name} on {chain} to a second wallet you control; allow 10 minutes and cap fees at $2.'],
  ['lending', 'Supply ${capital} to a liquid {name} lending market on {chain} for 7 days without borrowing; cap fees at $5.'],
  ['yield', 'Deposit ${capital} into a {name} yield vault on {chain} for 7 days; cap fees at $5.'],
  ['derivative', 'If offered, buy a defined-loss contract on {name} on {chain} using up to ${capital}; allow 20 minutes and cap fees at $5.'],
  ['perpetual', 'Open and close a ${capital} notional position at 1x on {name} on {chain}; allow 10 minutes and cap fees at $5.'],
  ['insurance', 'Buy a 30-day {name} cover on {chain} for an eligible position, with premium capped at ${capital}; cap fees at $5.'],
  ['stablecoin', 'Swap ${capital} into the {name} stablecoin on {chain} and hold 7 days; cap fees plus slippage at $5.'],
  ['option', 'Buy a {name} option on {chain} expiring within 7 days, with premium capped at ${capital}; cap fees at $5.'],
  ['privacy', 'If lawful where you live, shield then unshield ${capital} via {name} on {chain}; allow 30 minutes and cap fees at $5.'],
  ['index', 'Buy ${capital} of a {name} index on {chain} and hold 7 days; cap fees plus slippage at $5.'],
  ['launchpad', 'If eligible, commit up to ${capital} to a {name} sale on {chain}; allow 30 minutes, check lockups and cap fees at $5.'],
  ['synthetic', 'Swap ${capital} into a {name} synthetic asset on {chain} and hold 1 day; cap fees plus slippage at $5.'],
  ['oracle', 'If supported, stake ${capital} in a {name} oracle pool on {chain} for 7 days plus any unbonding; cap fees at $5.'],
  ['gaming', 'Complete one {name} gameplay session on {chain}, spending at most ${capital} in-game; allow 30 minutes and cap fees at $2.'],
  ['farm', 'Deposit ${capital} into a {name} farm on {chain} for 7 days, then withdraw and claim; cap fees at $5.'],
  ['chain', 'Bridge ${capital} to {chain} via its official bridge, then use an app listed by {name}; allow 30 minutes and cap fees at $10.'],
];

/** One risk sentence per category, in the same longest-first order as ACTIONS. */
const RISKS: [string, string][] = [
  ['risk curator', 'Curator errors, bad collateral and changing limits can create losses or delay withdrawals.'],
  ['onchain capital allocator', 'Allocator changes can move deposits into riskier markets or illiquid positions.'],
  ['cdp', 'Falling collateral prices or rising debt can trigger liquidation; the borrowed asset can also depeg.'],
  ['dex', 'Swaps face slippage and MEV; liquidity positions also face impermanent loss.'],
  ['rwa', 'Issuer default, legal restrictions and redemption windows can block access to funds.'],
  ['lending', 'Bad debt, oracle failures and low liquidity can cause losses or prevent withdrawals.'],
  ['yield', 'Yield can fall, while strategy losses and contract exploits can reduce principal.'],
  ['derivative', 'Leverage, settlement rules and thin liquidity can amplify losses or prevent exits.'],
  ['perpetual', 'Liquidation, funding charges and price gaps can consume margin quickly.'],
  ['basis trading', 'Funding can reverse, hedges can diverge and venue failures can leave exposure unhedged.'],
  ['leveraged farming', 'Borrow costs and falling collateral can erase yield and trigger liquidation.'],
  ['staking', 'Slashing, validator downtime and exit queues can reduce returns or delay withdrawals.'],
  ['payment', 'Wrong addresses, unsupported assets and irreversible transfers can cause permanent loss.'],
  ['chain', 'Sequencer outages, bridge failures and finality delays can trap funds or interrupt transactions.'],
  ['liquidity manager', 'Range changes, rebalancing costs and impermanent loss can outweigh trading fees.'],
];

const FALLBACK_ACTION = 'Deposit ${capital} of USDC into {name} on {chain} and keep the position open for 7 days; cap fees at $5.';
const FALLBACK_RISK = 'Smart-contract bugs, thin liquidity and sudden rule changes can lose the position or lock it.';

/** Fill {name}, {chain} and {capital} in a template. */
function fill(template: string, name: string, chain: string, capital: number): string {
  return template.replaceAll('{name}', name).replaceAll('{chain}', chain).replaceAll('{capital}', String(capital));
}

/** The first table row whose key the category's lowercase name contains, longest key first. */
function lookup(table: [string, string][], category: string | null, fallback: string): string {
  const c = (category ?? '').toLowerCase();
  let best: string | null = null;
  let bestLen = -1;
  for (const [key, value] of table) {
    if (c.includes(key) && key.length > bestLen) {
      best = value;
      bestLen = key.length;
    }
  }
  return best ?? fallback;
}

/** The category's one action, in the words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  return fill(lookup(ACTIONS, p.category, FALLBACK_ACTION), p.name, chain, capital);
}

/** The category's one risk, in one sentence. */
function riskFor(p: SnapshotProtocol): string {
  return lookup(RISKS, p.category, FALLBACK_RISK);
}

/**
 * A protocol's farm plan: eight steps, each an action with a cost and a time. The plan is derived
 * from the protocol's own record (category, chains, TVL, age), never from a hand-written list of
 * names: the category picks the action and the risk, the chain sets the gas, the TVL sets the
 * capital, and the age sets the hold.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const gas = gasFor(chain);
  return [
    {
      text: 'Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.',
      cost: 'under $3 of gas for the first transaction',
      time: '5 minutes',
    },
    {
      text: actionFor(p, capital, chain),
      cost: `$${capital} of capital and about $${gas} of gas on ${chain}`,
      time: '15 minutes to set up',
    },
    {
      text: 'Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.',
      cost: 'about $2 of gas a week',
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `Check the risk before you size up: ${riskFor(p)} Never farm with money you cannot afford to lose.`,
      cost: 'nothing but the read',
      time: '5 minutes',
    },
    {
      text: "Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.",
      cost: 'no fee to check, and never pay to claim',
      time: '10 minutes',
    },
    {
      text: `Plan the exit before you enter: check for lockups or exit queues on ${chain}, then unwind in two stages and keep any receipt token until the last claim clears.`,
      cost: `about $${gas * 2} of gas for two transactions`,
      time: '15 minutes',
    },
    {
      text: 'Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.',
      cost: 'nothing but the log',
      time: '5 minutes',
    },
  ];
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** A board row's compact form for data.js, with the farm plan generated in the page. */
export function radarRow(row: BoardRow, watchlist: Set<string>): RadarRow {
  return {
    rank: row.rank,
    watchlist: watchlist.has(row.slug),
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    age_used_days: row.age_used_days,
    implied_value_usd: row.implied_value_usd,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    breadth_multiplier: row.model.breadth_multiplier,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const { board, calibration } = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const watchlist = new Set(snapshot.watchlist);
  const early = board.filter((r) => !watchlist.has(r.slug)).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model: { ...model, base_multiple: calibration.multiple },
    model_version: MODEL_VERSION,
    calibration_n: calibration.n,
    calibration_band: CALIBRATION_BAND,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    rows: board.map((row) => radarRow(row, watchlist)),
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
