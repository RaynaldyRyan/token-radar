// Token Radar's page (no framework, no network): it reads window.RADAR from ../data.js and renders
// the board the model in lib/model.ts scored. It recomputes every row's implied value from the
// snapshot figures with the same function the model used — impliedOf — so the code the reader sees
// and the board's data are visibly the same arithmetic, and the model sandbox re-ranks live from
// the same figures instead of a stored list.
//
//   implied = tvl x base_multiple x growthMult x maturityMult x breadthMult
//   base_multiple is calibrated from the snapshot: the median mcap/TVL of its live-token protocols,
//   ratios outside 0.005..5 discarded. On this snapshot it is 0.2042 from 115 protocols.
//   growthMult = 1 + clamp(change_7d, -60, 120) / 100 x 0.5
//   maturityMult = 0.6 + min(age, 1095) / 1095 x 0.4 (age = days since DefiLlama first listed it;
//   a protocol with no listed date takes its category's median age, then the global median)
//   breadthMult = 1 + 0.05 x min(chains - 1, 4), capped at 1.20
//
// A protocol is pre-token when the snapshot records no token for it (no market cap, no CoinGecko
// id, no symbol); say it records no token, never that it has none. The board covers the whole
// watchlist and every rankable pre-token protocol below the floor: no wrapped, staked or bridged
// product of a token that already trades, no exchange, no versioned pool. Live-token protocols are
// set apart on the Live token tab, at the market's own value. Farm plans come from the protocol's
// own record: the category picks the action and the risk, the chain sets the gas, the TVL sets the
// capital, the age sets the hold. No name is ever special-cased.

(function () {
  'use strict';
  const root = document.getElementById('board');
  const RADAR = window.RADAR || null;
  if (!RADAR || !Array.isArray(RADAR.rows)) {
    root.innerHTML = '<div class="shell"><p>Token Radar needs data.js beside the dashboard. The program writes it from the snapshot.</p></div>';
    return;
  }

  /** An HTML-safe string. */
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const finite = (n, fallback) => (typeof n === 'number' && Number.isFinite(n) ? n : fallback);
  const usd = (n) => {
    const v = finite(n, 0);
    if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
    if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
    if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
    return `$${v.toFixed(0)}`;
  };
  const pct = (n) => {
    if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
    return `${n > 0 ? '+' : ''}${n.toFixed(1)}%`;
  };
  const ageText = (days) => {
    if (typeof days !== 'number') return '—';
    if (days < 90) return `${days}d`;
    if (days < 730) return `${(days / 30.44).toFixed(1)}mo`;
    return `${(days / 365.25).toFixed(1)}y`;
  };
  const chainList = (chains) => (Array.isArray(chains) && chains.length > 0 ? chains.slice(0, 3).join(', ') + (chains.length > 3 ? ` +${chains.length - 3}` : '') : '—');
  const byId = (id) => document.getElementById(id);

  /** A row is on the watchlist when the program marked it: data.js carries the flag per row. */
  const onWatchlist = (r) => r.watchlist === true;

  /** One row's implied value under a model, the same arithmetic as lib/model.ts's impliedValue. */
  function impliedOf(r, m) {
    const growthPct = Math.min(m.growth_cap, Math.max(m.growth_floor, finite(r.change_7d, 0)));
    const growthMult = 1 + (growthPct / 100) * m.growth_weight;
    const maturityMult = m.maturity_floor + (Math.min(Math.max(r.age_used_days, 0), m.maturity_days) / m.maturity_days) * m.maturity_range;
    const breadthMult = 1 + m.breadth_step * Math.min(Math.max(r.chains.length - 1, 0), m.breadth_cap);
    return Math.max(1, Math.round(r.tvl_usd * m.base_multiple * growthMult * maturityMult * breadthMult));
  }

  /** The three multipliers behind one row, for the detail view's equation. */
  function multipliersOf(r, m) {
    const growthPct = Math.min(m.growth_cap, Math.max(m.growth_floor, finite(r.change_7d, 0)));
    return {
      growthPct,
      growth: 1 + (growthPct / 100) * m.growth_weight,
      maturity: m.maturity_floor + (Math.min(Math.max(r.age_used_days, 0), m.maturity_days) / m.maturity_days) * m.maturity_range,
      breadth: 1 + m.breadth_step * Math.min(Math.max(r.chains.length - 1, 0), m.breadth_cap),
    };
  }

  /** The model the page runs: the calibrated one, with the sandbox's overrides folded in. */
  const model = () => ({ ...RADAR.model, ...state.overrides });

  const chainOf = (r) => (Array.isArray(r.chains) && r.chains.length > 0 ? r.chains[0] : 'its main chain');
  const capitalFor = (r) => (r.tvl_usd >= 5e9 ? 250 : r.tvl_usd >= 1e9 ? 150 : r.tvl_usd >= 1e8 ? 100 : 50);
  const holdDaysFor = (age) => (age === null || age === undefined ? 30 : age < 180 ? 60 : age < 365 ? 45 : 30);
  const gasFor = (chain) => {
    const c = String(chain).toLowerCase();
    if (c === 'ethereum') return 8;
    if (c === 'solana') return 1;
    if (c === 'tron' || c === 'bitcoin' || c === 'bittensor') return 2;
    return 1;
  };

  /** One farm action per category, in the same longest-first order as the model's ACTIONS table. */
  const ACTIONS = [
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
  const RISKS = [
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
  const fill = (t, name, chain, capital) => t.split('{name}').join(name).split('{chain}').join(chain).split('{capital}').join(String(capital));
  const lookup = (table, category, fallback) => {
    const c = String(category || '').toLowerCase();
    let best = null;
    let bestLen = -1;
    for (const [key, value] of table) {
      if (c.includes(key) && key.length > bestLen) { best = value; bestLen = key.length; }
    }
    return best || fallback;
  };

  /** A protocol's farm plan: eight steps, the same plan the model writes into board.json. */
  function farmSteps(r) {
    const chain = chainOf(r);
    const capital = capitalFor(r);
    const hold = holdDaysFor(r.age_days);
    const gas = gasFor(chain);
    return [
      { text: 'Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.', cost: 'under $3 of gas for the first transaction', time: '5 minutes' },
      { text: fill(lookup(ACTIONS, r.category, FALLBACK_ACTION), r.name, chain, capital), cost: `$${capital} of capital and about $${gas} of gas on ${chain}`, time: '15 minutes to set up' },
      { text: 'Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.', cost: 'about $2 of gas a week', time: '10 minutes a week' },
      { text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`, cost: `the $${capital} stays in the position`, time: `${hold} days` },
      { text: `Check the risk before you size up: ${lookup(RISKS, r.category, FALLBACK_RISK)} Never farm with money you cannot afford to lose.`, cost: 'nothing but the read', time: '5 minutes' },
      { text: "Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.", cost: 'no fee to check, and never pay to claim', time: '10 minutes' },
      { text: `Plan the exit before you enter: check for lockups or exit queues on ${chain}, then unwind in two stages and keep any receipt token until the last claim clears.`, cost: `about $${gas * 2} of gas for two transactions`, time: '15 minutes' },
      { text: 'Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.', cost: 'nothing but the log', time: '5 minutes' },
    ];
  }

  const CATEGORIES = [...new Set(RADAR.rows.map((r) => r.category).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const CHAINS = [...new Set(RADAR.rows.flatMap((r) => r.chains))].sort((a, b) => a.localeCompare(b));
  const SORTS = [
    ['implied', 'Implied value'],
    ['tvl', 'TVL'],
    ['growth', '7d growth'],
    ['age', 'Age (oldest)'],
    ['name', 'Name A–Z'],
  ];

  const state = {
    q: '',
    category: '',
    chain: '',
    watchlistOnly: false,
    tab: 'pre',
    sort: 'implied',
    overrides: {},
    slug: null,
  };

  /** The URL hash carries the view: #p=slug opens a detail, #q, #category, #chain, #watchlist=1 filter. */
  function readHash() {
    const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    state.q = params.get('q') || '';
    state.category = params.get('category') || '';
    state.chain = params.get('chain') || '';
    state.watchlistOnly = params.get('watchlist') === '1';
    state.tab = params.get('tab') === 'live' ? 'live' : 'pre';
    state.sort = SORTS.some(([k]) => k === params.get('sort')) ? params.get('sort') : 'implied';
    state.slug = params.get('p') || null;
  }
  function writeHash() {
    const params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.category) params.set('category', state.category);
    if (state.chain) params.set('chain', state.chain);
    if (state.watchlistOnly) params.set('watchlist', '1');
    if (state.tab === 'live') params.set('tab', 'live');
    if (state.sort !== 'implied') params.set('sort', state.sort);
    if (state.slug) params.set('p', state.slug);
    const next = params.toString();
    const target = next ? `#${next}` : '';
    if (window.location.hash !== target) history.replaceState(null, '', target || window.location.pathname);
  }

  const sandboxActive = () => Object.keys(state.overrides).length > 0;
  const sorted = (rows) => {
    const m = model();
    const key = state.sort;
    const withImplied = rows.map((r) => ({ r, implied: impliedOf(r, m) }));
    withImplied.sort((a, b) => {
      if (key === 'tvl') return b.r.tvl_usd - a.r.tvl_usd;
      if (key === 'growth') return finite(b.r.change_7d, -1e9) - finite(a.r.change_7d, -1e9);
      if (key === 'age') return (b.r.age_used_days ?? 0) - (a.r.age_used_days ?? 0);
      if (key === 'name') return a.r.name.localeCompare(b.r.name);
      return b.implied - a.implied || (a.r.slug < b.r.slug ? -1 : 1);
    });
    return withImplied;
  };

  function filtered() {
    const q = state.q.trim().toLowerCase();
    return RADAR.rows.filter((r) => {
      if (state.watchlistOnly && !onWatchlist(r)) return false;
      if (state.category && r.category !== state.category) return false;
      if (state.chain && !r.chains.includes(state.chain)) return false;
      if (q && !(`${r.name} ${r.slug} ${r.category || ''}`.toLowerCase().includes(q))) return false;
      return true;
    });
  }

  const maxImplied = Math.max(...RADAR.rows.map((r) => r.implied_value_usd));
  const totalImplied = RADAR.rows.reduce((s, r) => s + r.implied_value_usd, 0);

  const header = () => `
    <div class="shell">
      <header class="top">
        <div class="brand"><span class="radar-mark" aria-hidden="true"></span><span class="brand-name">Token Radar</span></div>
        <div class="top-meta">
          <span>Snapshot ${esc(RADAR.as_of)}</span>
          <span>DefiLlama snapshot</span>
          <span>Model ${esc(RADAR.model_version)}</span>
        </div>
      </header>
      <section class="lede" aria-labelledby="lede-title">
        <div>
          <h1 id="lede-title">Which DeFi protocol launches next, and what is it worth?</h1>
          <p>Every protocol in the snapshot that records no token, ranked by its implied launch value — a value that follows from the snapshot's own figures, never from a list of names. Open a row for the model's arithmetic and a farm plan with costs and times.</p>
        </div>
        <dl class="facts">
          <div class="fact"><span>Pre-token protocols ranked</span><b>${RADAR.board_size}</b></div>
          <div class="fact"><span>Watchlist covered, of ${RADAR.watchlist_size}</span><b>${RADAR.watchlist_size}</b></div>
          <div class="fact"><span>Early radar, below the ${usd(RADAR.floor_usd)} floor</span><b>${RADAR.early_size}</b></div>
          <div class="fact"><span>Implied value on the board</span><b>${usd(totalImplied)}</b></div>
          <div class="fact"><span>Live-token protocols set aside</span><b>${RADAR.live_size}</b></div>
        </dl>
      </section>
      <div class="controls" role="search" aria-label="Filter the board">
        <div class="field"><label for="q">Search</label><input id="q" type="search" placeholder="Name, slug or category" value="${esc(state.q)}" autocomplete="off"></div>
        <div class="field"><label for="category">Category</label><select id="category">
          <option value="">All categories</option>
          ${CATEGORIES.map((c) => `<option value="${esc(c)}"${c === state.category ? ' selected' : ''}>${esc(c)}</option>`).join('')}
        </select></div>
        <div class="field"><label for="chain">Chain</label><select id="chain">
          <option value="">All chains</option>
          ${CHAINS.map((c) => `<option value="${esc(c)}"${c === state.chain ? ' selected' : ''}>${esc(c)}</option>`).join('')}
        </select></div>
        <div class="field"><label for="sort">Sort by</label><select id="sort">
          ${SORTS.map(([k, label]) => `<option value="${k}"${k === state.sort ? ' selected' : ''}>${label}</option>`).join('')}
        </select></div>
        <div class="tabs" role="group" aria-label="Pre-token or live">
          <button type="button" id="tab-pre" aria-pressed="${state.tab === 'pre'}">Pre-token (${RADAR.board_size})</button>
          <button type="button" id="tab-live" aria-pressed="${state.tab === 'live'}">Live token (${RADAR.live_size})</button>
        </div>
        <label class="check"><input type="checkbox" id="watchlist-only"${state.watchlistOnly ? ' checked' : ''}> Watchlist only</label>
        <span class="count" id="count" aria-live="polite"></span>
      </div>
      <div id="table-slot"></div>
      <div id="model-slot"></div>
      <footer class="foot panel">
        <p><strong>How to read this board.</strong> Implied value is a model's estimate of what a launch would be worth, not a price and not a promise: the base multiple is the snapshot's own median market-cap-to-TVL ratio across its live-token protocols, and the growth, maturity and breadth multipliers come from each protocol's own figures. A protocol is pre-token when the snapshot records no token for it; that says nothing about its plans. Farm plans are a starting point, not advice — check the protocol's own page before you move funds, and never pay to claim.</p>
        <p>Source: a sealed DefiLlama snapshot of ${esc(RADAR.as_of)}, ${RADAR.board_size} pre-token protocols ranked and ${RADAR.live_size} live-token protocols set aside. This page runs with no network: every number it shows is in data.js, and the board it renders is board.json.</p>
      </footer>
    </div>
    <dialog class="detail" id="detail" aria-label="Protocol detail"></dialog>
  `;

  const rowHtml = (item, displayRank) => {
    const r = item.r;
    const growth = r.change_7d;
    const growthClass = typeof growth === 'number' ? (growth >= 0 ? 'pos' : 'neg') : '';
    const barPct = Math.max(2, Math.min(100, (item.implied / maxImplied) * 100));
    return `<tr data-slug="${esc(r.slug)}" data-selected="${state.slug === r.slug}" tabindex="0">
      <td class="num">${displayRank}</td>
      <td><span class="name"><b>${esc(r.name)}${onWatchlist(r) ? '<span class="badge">Watchlist</span>' : ''}</b><span class="sub">${esc(r.category || 'Other')} · ${esc(chainList(r.chains))}</span></span></td>
      <td><span class="implied"><span class="bar" aria-hidden="true"><i style="width:${barPct}%"></i></span><span class="num">${usd(item.implied)}</span></span></td>
      <td class="num">${usd(r.tvl_usd)}</td>
      <td class="num ${growthClass}">${pct(growth)}</td>
      <td class="num">${ageText(r.age_used_days)}${r.age_days === null ? ' *' : ''}</td>
      <td><span class="status">Pre-token</span></td>
    </tr>`;
  };

  const preTable = (items) => `
    <section class="panel" aria-label="Ranked pre-token protocols">
      <div class="table-wrap"><table>
        <thead><tr>
          <th scope="col">Rank</th><th scope="col">Protocol</th><th scope="col">Implied value</th>
          <th scope="col">TVL</th><th scope="col">7d change</th><th scope="col">Age</th><th scope="col">Token</th>
        </tr></thead>
        <tbody>${items.map((item, i) => rowHtml(item, i + 1)).join('')}</tbody>
      </table></div>
    </section>
    <p class="sub" style="margin-top:8px">* Age with an asterisk is a fallback: the snapshot lists no date for that protocol, so the model uses its category's median age. Ranks follow the page's sort; the board's own order is implied value, highest first.</p>
  `;

  const liveTable = () => `
    <section class="panel" aria-label="Live-token protocols, set apart">
      <div class="table-wrap"><table>
        <thead><tr>
          <th scope="col">Protocol</th><th scope="col">Market cap</th><th scope="col">TVL</th>
          <th scope="col">Mcap / TVL</th><th scope="col">7d change</th><th scope="col">Token</th>
        </tr></thead>
        <tbody>${RADAR.live.map((l) => {
          const ratio = l.mcap_usd !== null && l.tvl_usd > 0 ? (l.mcap_usd / l.tvl_usd).toFixed(2) : '—';
          const growth = l.change_7d;
          const growthClass = typeof growth === 'number' ? (growth >= 0 ? 'pos' : 'neg') : '';
          return `<tr data-live="${esc(l.slug)}" tabindex="0">
            <td><span class="name"><b>${esc(l.name)}</b><span class="sub">${esc(l.category || 'Other')} · ${esc(chainList(l.chains))}</span></span></td>
            <td class="num">${l.mcap_usd === null ? '—' : usd(l.mcap_usd)}</td>
            <td class="num">${usd(l.tvl_usd)}</td>
            <td class="num">${ratio}</td>
            <td class="num ${growthClass}">${pct(growth)}</td>
            <td><span class="status">Live token</span></td>
          </tr>`;
        }).join('')}</tbody>
      </table></div>
    </section>
    <p class="sub" style="margin-top:8px">These protocols already trade, so the model never ranks them — but their median market-cap-to-TVL ratio is what calibrates the base multiple. The top ${RADAR.live_size} by market cap are shown.</p>
  `;

  const emptyTable = () => `
    <section class="panel empty" aria-label="No protocols match">
      <h2>Nothing matches this filter.</h2>
      <p>Try a shorter search, a different category, or clear the watchlist filter.</p>
      <button type="button" class="button primary" id="clear-filters">Clear filters</button>
    </section>
  `;

  const modelPanel = () => {
    const m = RADAR.model;
    const o = state.overrides;
    return `
    <section class="panel model" aria-labelledby="model-title">
      <h2 id="model-title">The model: ${esc(RADAR.model_version)}</h2>
      <p class="formula">implied value = TVL × ${m.base_multiple} (calibrated from ${RADAR.calibration_n} live-token protocols, median mcap/TVL, ratios outside ${RADAR.calibration_band.lo}–${RADAR.calibration_band.hi} discarded)<br>
        × growth (1 + clamp(7d change, −60, 120) / 100 × ${m.growth_weight})<br>
        × maturity (0.6 + min(age, 1,095d) / 1,095 × 0.4)<br>
        × breadth (1 + 0.05 × min(chains − 1, 4))</p>
      <p>Every input is the snapshot's own: TVL, 7-day growth, age since first listing, chain count. No protocol name is special-cased — the same function scores every row, and the sandbox below re-ranks the board from those same figures.</p>
      <div class="sandbox">
        <h3>Model sandbox</h3>
        <div class="sliders">
          <div class="slider"><label for="sb-multiple"><span>Base multiple</span><b id="sb-multiple-val">${(o.base_multiple ?? m.base_multiple).toFixed(2)}</b></label>
            <input type="range" id="sb-multiple" min="0.05" max="0.50" step="0.01" value="${o.base_multiple ?? m.base_multiple}"></div>
          <div class="slider"><label for="sb-growth"><span>Growth weight</span><b id="sb-growth-val">${(o.growth_weight ?? m.growth_weight).toFixed(1)}</b></label>
            <input type="range" id="sb-growth" min="0" max="1" step="0.1" value="${o.growth_weight ?? m.growth_weight}"></div>
          <div class="slider"><label for="sb-maturity"><span>Maturity range</span><b id="sb-maturity-val">${(o.maturity_range ?? m.maturity_range).toFixed(1)}</b></label>
            <input type="range" id="sb-maturity" min="0" max="0.6" step="0.1" value="${o.maturity_range ?? m.maturity_range}"></div>
        </div>
        <p class="sandbox-note">${sandboxActive() ? 'Sandbox values are live: the board above re-ranks from them. board.json keeps the calibrated model.' : 'Move a slider to re-rank the board from the same snapshot figures. The sandbox changes this page only.'} <button type="button" class="button" id="sb-reset">Reset to calibrated</button></p>
      </div>
    </section>`;
  };

  function detailHtml(r) {
    const m = model();
    const mult = multipliersOf(r, m);
    const implied = impliedOf(r, m);
    const steps = farmSteps(r);
    const ageNote = r.age_days === null
      ? `The snapshot lists no date for ${r.name}, so the model uses its category's median age of ${r.age_used_days} days.`
      : `First listed ${esc(r.listed_at)} — ${r.age_days} days with no token recorded.`;
    return `
      <div class="detail-head">
        <div>
          <span class="sub">Rank ${r.rank} of ${RADAR.board_size}${onWatchlist(r) ? ' · on the watchlist' : ''}</span>
          <h2>${esc(r.name)}</h2>
          <p class="sub">${esc(r.category || 'Other')} · ${esc(r.chains.join(', ') || 'no chain listed')} · ${esc(r.slug)}</p>
        </div>
        <button type="button" class="close" id="detail-close">Close ✕</button>
      </div>
      <section class="detail-section" aria-labelledby="eq-title">
        <h3 id="eq-title">Why this rank</h3>
        <div class="equation">
          <div><span>TVL</span><b>${usd(r.tvl_usd)}</b></div>
          <div><span>× base multiple (calibrated)</span><b>${m.base_multiple.toFixed(4)}</b></div>
          <div><span>× growth (${pct(r.change_7d)} over 7d, clamped to ${mult.growthPct.toFixed(1)}%)</span><b>${mult.growth.toFixed(3)}</b></div>
          <div><span>× maturity (${ageText(r.age_used_days)} old)</span><b>${mult.maturity.toFixed(3)}</b></div>
          <div><span>× breadth (${r.chains.length} chain${r.chains.length === 1 ? '' : 's'})</span><b>${mult.breadth.toFixed(3)}</b></div>
          <div class="total"><span>Implied value</span><b>${usd(implied)}</b></div>
        </div>
        <p class="sub" style="margin-top:8px">${ageNote}</p>
      </section>
      <section class="detail-section" aria-labelledby="farm-title">
        <h3 id="farm-title">Farm plan</h3>
        <ol class="steps">
          ${steps.map((s) => `<li><b>${esc(s.text)}</b><span class="cost">Cost: ${esc(s.cost)} · Time: ${esc(s.time)}</span></li>`).join('')}
        </ol>
      </section>
      <section class="detail-section">
        <p class="sub">The plan comes from ${esc(r.name)}'s own record — its category, its chains, its TVL and its age. It is a starting point, not advice: check the protocol's own page before you move funds, and never pay to claim.</p>
      </section>
    `;
  }

  function liveDetailHtml(l) {
    const ratio = l.mcap_usd !== null && l.tvl_usd > 0 ? (l.mcap_usd / l.tvl_usd).toFixed(2) : '—';
    return `
      <div class="detail-head">
        <div>
          <span class="sub">Live token · set apart from the board</span>
          <h2>${esc(l.name)}</h2>
          <p class="sub">${esc(l.category || 'Other')} · ${esc(l.chains.join(', ') || 'no chain listed')} · ${esc(l.slug)}</p>
        </div>
        <button type="button" class="close" id="detail-close">Close ✕</button>
      </div>
      <section class="detail-section">
        <div class="equation">
          <div><span>Market cap</span><b>${l.mcap_usd === null ? '—' : usd(l.mcap_usd)}</b></div>
          <div><span>TVL</span><b>${usd(l.tvl_usd)}</b></div>
          <div><span>Mcap / TVL</span><b>${ratio}</b></div>
          <div><span>7d change</span><b>${pct(l.change_7d)}</b></div>
        </div>
        <p class="sub" style="margin-top:8px">${esc(l.name)} already trades, so the model never ranks it. Its market-cap-to-TVL ratio is one of the ${RADAR.calibration_n} that calibrate the base multiple.</p>
      </section>
    `;
  }

  const dialog = () => byId('detail');

  function openDetail(slug) {
    const r = RADAR.rows.find((x) => x.slug === slug);
    if (!r) return;
    state.slug = slug;
    writeHash();
    const d = dialog();
    d.innerHTML = detailHtml(r);
    byId('detail-close').addEventListener('click', closeDetail);
    if (!d.open) d.showModal();
    renderTable();
  }
  function openLiveDetail(slug) {
    const l = RADAR.live.find((x) => x.slug === slug);
    if (!l) return;
    const d = dialog();
    d.innerHTML = liveDetailHtml(l);
    byId('detail-close').addEventListener('click', closeDetail);
    if (!d.open) d.showModal();
  }
  function closeDetail() {
    state.slug = null;
    writeHash();
    const d = dialog();
    if (d.open) d.close();
    renderTable();
  }

  function renderTable() {
    const slot = byId('table-slot');
    const count = byId('count');
    if (state.tab === 'live') {
      slot.innerHTML = liveTable();
      count.textContent = `${RADAR.live_size} live-token protocols, set apart from the board.`;
      slot.querySelectorAll('tr[data-live]').forEach((tr) => {
        tr.addEventListener('click', () => openLiveDetail(tr.dataset.live));
        tr.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openLiveDetail(tr.dataset.live); } });
      });
      return;
    }
    const items = sorted(filtered());
    count.textContent = items.length === RADAR.board_size
      ? `${items.length} pre-token protocols${sandboxActive() ? ', re-ranked by the sandbox' : ''}.`
      : `${items.length} of ${RADAR.board_size} pre-token protocols.`;
    slot.innerHTML = items.length === 0 ? emptyTable() : preTable(items);
    if (items.length === 0) {
      byId('clear-filters').addEventListener('click', () => {
        state.q = ''; state.category = ''; state.chain = ''; state.watchlistOnly = false;
        render();
      });
      return;
    }
    slot.querySelectorAll('tr[data-slug]').forEach((tr) => {
      tr.addEventListener('click', () => openDetail(tr.dataset.slug));
      tr.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(tr.dataset.slug); } });
    });
  }

  function renderModel() {
    byId('model-slot').innerHTML = modelPanel();
    const bind = (id, key, format) => {
      const input = byId(id);
      input.addEventListener('input', () => {
        state.overrides[key] = parseFloat(input.value);
        byId(`${id}-val`).textContent = format(state.overrides[key]);
        renderTable();
        renderModel();
      });
    };
    bind('sb-multiple', 'base_multiple', (v) => v.toFixed(2));
    bind('sb-growth', 'growth_weight', (v) => v.toFixed(1));
    bind('sb-maturity', 'maturity_range', (v) => v.toFixed(1));
    byId('sb-reset').addEventListener('click', () => {
      state.overrides = {};
      renderTable();
      renderModel();
    });
  }

  function render() {
    readHash();
    root.innerHTML = header();
    root.setAttribute('aria-busy', 'false');
    renderTable();
    renderModel();
    byId('q').addEventListener('input', (e) => { state.q = e.target.value; writeHash(); renderTable(); });
    byId('category').addEventListener('change', (e) => { state.category = e.target.value; writeHash(); renderTable(); });
    byId('chain').addEventListener('change', (e) => { state.chain = e.target.value; writeHash(); renderTable(); });
    byId('sort').addEventListener('change', (e) => { state.sort = e.target.value; writeHash(); renderTable(); });
    byId('watchlist-only').addEventListener('change', (e) => { state.watchlistOnly = e.target.checked; writeHash(); renderTable(); });
    byId('tab-pre').addEventListener('click', () => { state.tab = 'pre'; writeHash(); renderTable(); renderTabs(); });
    byId('tab-live').addEventListener('click', () => { state.tab = 'live'; writeHash(); renderTable(); renderTabs(); });
    dialog().addEventListener('close', () => { if (state.slug) { state.slug = null; writeHash(); renderTable(); } });
    if (state.slug) {
      const r = RADAR.rows.find((x) => x.slug === state.slug);
      if (r) {
        const d = dialog();
        d.innerHTML = detailHtml(r);
        byId('detail-close').addEventListener('click', closeDetail);
        if (!d.open) d.showModal();
      }
    }
  }

  function renderTabs() {
    byId('tab-pre').setAttribute('aria-pressed', String(state.tab === 'pre'));
    byId('tab-live').setAttribute('aria-pressed', String(state.tab === 'live'));
  }

  window.addEventListener('hashchange', () => { render(); });
  render();
})();
