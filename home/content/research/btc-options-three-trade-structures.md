---
title: "BTC Options: Three Trade Structures"
description: "Which structures best express a bullish view, a bearish view, and a view that election-week volatility is overpriced?"
date: "2026-10-29"
category: "Options research"
tags:
  - BTC
  - Options
  - Macro
---

**29 October 2026 | Reference BTC spot: ~$80,100 | Macro context updated after the 28 Oct FOMC and 29 Oct economic releases**  
**Question:** Which structures best express a bullish view, a bearish view, and a view that election-week volatility is overpriced?

## Executive summary

The opportunity is in the November expiries. The 6 November ATM option carries **36.1% IV**, versus **28.1%** for 31 October, implying **~38.3% forward volatility** from 31 October to 6 November. That is an event-rich interval, but not an isolated midterm-election trade: AI earnings, monetary-policy repricing, inflation, risk-asset deleveraging and geopolitical headlines also influence BTC risk. **No realized-volatility forecast is drawn from the five-day Deribit trade tape.**

The distinction is between *ordinary* variance and *event* variance. Selling the 6 November straddle and delta-hedging does not automatically harvest the headline IV: remaining event variance can keep annualized IV **rising** as expiry approaches. The key test is **daily, weekday-adjusted implied versus expected realized variance**, plus the possibility of a repricing of the remaining event component before the planned 2 November exit.

**The three candidate trades are alternatives, not a portfolio:**

| View | Structure | Scenario it monetizes |
|---|---|---|
| **Bullish** | Buy 13 Nov $82k call / sell $88k call | Recovery through $83–84k toward $86–88k |
| **Bearish** | Buy 27 Nov $80k put / sell $74k put | Failure of $78k support and continuation toward $74k |
| **Short volatility** | Sell 6 Nov $80k straddle, delta-hedge | Realized variance and/or the **remaining election variance** fall below what is priced; reassess before 3 Nov |

The short straddle has **two management outcomes**, not two separate trade recommendations: close before the election to harvest ordinary variance and any repricing of event risk, or deliberately retain election jump exposure through expiry.

---

## 1. RV versus IV: decompose the curve first

### Term structure

ATM IV and the historical-RV reference below are read from the supplied term-structure chart. Historical RV on the chart is **not** a forward forecast.

::research-term-structure{snapshot="btc-options-2026-10-29" focus-expiry="2026-11-06"}
::

| Expiry | ATM IV | Historical RV reference | IV − RV |
|---|---:|---:|---:|
| 30 Oct | 29.0% | ~31.8% | −2.8 pts |
| 31 Oct | 28.1% | ~29.1% | −1.0 pts |
| **6 Nov** | **36.1%** | ~30.0% | **+6.1 pts** |
| 13 Nov | 35.6% | ~31.8% | +3.8 pts |
| 27 Nov | 35.2% | ~31.1% | +4.1 pts |
| 25 Dec | 36.1% | ~33.5% | +2.6 pts |
| 26 Mar 2027 | 37.8% | ~38.3% | −0.5 pts |
| 25 Jun 2027 | 38.8% | ~39.0% | −0.2 pts |

**RV methodology.** The chart's 29–32% near-term historical-RV references use trailing windows and are not forecasts. **Do not use the five-day Deribit derivatives sample to estimate expected RV.** Build the physical-volatility forecast from a representative **2024–2026 hourly BTC spot-price history**, combining a regime estimate (e.g., 30/90/180-day realized variance) with weekday/weekend seasonality and event-day adjustments. Until that independent spot-history model is fitted, **30% and 32% full-week annualized RV are illustrative scenarios, not forecasts**.

A study of hourly spot returns reports weekend-to-weekday volatility ratios of **0.60 in 2024 and 0.64 in 2025**; a separate CME analysis describes weekends at around **75% of weekday volatility** on its own measure. Treat **0.62–0.75** as a *seasonality sensitivity range*, not a measured October 2026 coefficient. [Hourly BTC weekend/weekday study](https://www.mdpi.com/1911-8074/19/9/707) · [CME spot BTC weekday/weekend study](https://www.cmegroup.com/articles/2026/aligning-cryptocurrency-derivatives-with-spot-markets-measuring-the-247-trading-opportunity.html).

### Event calendar and the macro overlay

| Event | Date | Relevant expiry |
|---|---|---|
| October FOMC | **28 Oct, completed: 3.75–4.00% hold; two dissents preferred a hike** | Current implied curve already follows this decision |
| September PCE and Q3 GDP | **29 Oct, released: PCE +3.6% y/y; GDP +3.4% annualized** | 30/31 Oct; subsequent rate repricing |
| Big-tech earnings | **28–29 Oct: Microsoft/Alphabet reported; Amazon and Intel still due after US close on 29 Oct** | 30/31 Oct; cross-asset carry into weekend |
| US midterm elections | **3 Nov** | **6 Nov** |
| US employment report | 6 Nov, 08:30 ET | **13 Nov**, not 6 Nov |
| US CPI | 10 Nov, 08:30 ET | 13 Nov |
| December FOMC | 8–9 Dec | 25 Dec |
| December CPI | 10 Dec | 25 Dec |

Deribit BTC options expire at **08:00 UTC**, so the 6 November expiry settles *before* that morning's US employment report. The Monday academy brief described the Fed, earnings and Thursday's growth/inflation releases as impending; **by this report's 29 October update the Fed and BEA releases have already occurred**. [FOMC statement](https://www.federalreserve.gov/newsevents/pressreleases/monetary20261028a.htm) · [BEA GDP](https://www.bea.gov/data/gdp/gross-domestic-product) · [BEA PCE](https://www.bea.gov/data/personal-consumption-expenditures-price-index/) · [BLS calendar](https://www.bls.gov/schedule/2026/11_sched_list.htm).

### What the academy brief changes about the volatility view

The academy's **Monday, 26 October *Week Ahead*** report describes three connected pressures: **AI-related equity repricing**, **higher-rate/inflation risk**, and **oil/geopolitical risk**. BTC's dip below $80k, forced-long liquidation and roughly **$772m of two-day spot-BTC ETF outflows** are evidence of transmission into crypto, not three independent Bitcoin-specific events. [Contemporaneous market report](https://finance.yahoo.com/markets/crypto/articles/bitcoin-dips-below-80-000-053556739.html).

The week's subsequent information has reinforced the two-sided macro risk: the Fed **held at 3.75–4.00%** but two members wanted a hike, September PCE was **3.6% y/y**, and Q3 GDP grew **3.4% annualized**. Strong growth together with sticky inflation leaves rate repricing live. Meanwhile, Microsoft and Alphabet received **divergent equity-market reactions** to AI earnings, illustrating that even large reported AI spending and strong cloud growth need not translate into a uniform risk-on response. Amazon and Intel earnings remain a potential **Thursday-after-close** catalyst. [Fed](https://www.federalreserve.gov/newsevents/pressreleases/monetary20261028a.htm) · [BEA](https://www.bea.gov/data/personal-consumption-expenditures-price-index/) · [GDP](https://www.bea.gov/data/gdp/gross-domestic-product) · [Earnings reaction](https://www.wsj.com/livecoverage/stock-market-today-dow-sp-500-nasdaq-10-29-2026/card/stocks-to-watch-alphabet-amazon-intel-pUhPigvSxA16EOR39sqe).

The oil channel is particularly relevant to **overnight and weekend jump risk**: de-escalation news can ease oil and rate pressure, while renewed Middle East disruptions can reverse that quickly. Neither scenario waits for US cash-market hours. [Reuters on 29 October oil/geopolitics](https://www.reuters.com/business/energy/us-oil-prices-fall-investors-gauge-risks-mideast-supply-2026-10-29/).

**Volatility inference:** The **31 October–6 November forward-volatility kink is a premium for an event cluster, not a clean estimate of midterm-election variance**. A straddle seller cannot attribute all implied excess variance to 3 November, and a quiet weekend is less predictive of the following Monday/Tuesday when multiple macro narratives are unresolved. This strengthens the rationale for a **pre-election exit review** but weakens the idea that carry before the election is automatically attractive.

**Event sequence relevant to the trade**

| Interval (UTC) | Variance driver | Short-hedged-straddle implication |
|---|---|---|
| **Thu 29–Fri 30 Oct** | Absorption of FOMC/PCE/GDP, AI earnings reactions, ETF/leveraging flows | **Weekday RV can exceed its seasonal baseline**; do not price these as ordinary days automatically |
| **Sat 31 Oct–Sun 1 Nov** | Normally quieter trading; geopolitical headlines and thinner liquidity remain | Lower diffusion does not eliminate **jump/gap** risk; weekend RV and implied clock may both slow |
| **Mon 2 Nov** | US cash markets reopen; election positioning and macro repricing | Planned **risk review/possible exit**; mark remaining event variance, not just headline IV |
| **Tue 3 Nov onward** | Election result and ensuing price discovery | Carry only if deliberately accepting event jump and high-gamma exposure |

The brief's FedWatch percentage was a **dated Monday market snapshot**, not an input to the 29 October variance model; the Brazil election, Anthropic IPO and small intraday oil prints do not materially change the straddle analysis and are omitted.

### Extract the forward variance

Write total implied variance as $$w(T)=\sigma(T)^2T$$. For expiries $$T_1<T_2$$:

$$
\sigma_{\mathrm{fwd},1\to2}=\sqrt{\frac{\sigma_2^2T_2-\sigma_1^2T_1}{T_2-T_1}}.
$$

Using the chart's IVs and a 29 October 10:31 UTC valuation time:

| Segment | Forward IV | Main risk |
|---|---:|---|
| 31 Oct → 6 Nov | **38.3%** | Election reaction |
| 6 Nov → 13 Nov | **35.0%** | Employment report, CPI, subsequent repricing |

Under **illustrative full-window RV baselines** of **30%** and **32%**, the excess variance embedded in 38.3% forward IV is equivalent to a one-off shock of approximately **3.1%** and **2.7%**, respectively (about **$2,450** and **$2,160** at $80,100). That is a **variance-equivalent magnitude for the entire 31 Oct–6 Nov segment**, not a forecast or a separately identifiable election jump: it can be consumed by employment/rates positioning, AI spillovers, oil headlines, and the election together. A fitted forward RV forecast must also allocate Saturday/Sunday variance below ordinary weekday variance.

### How informative are previous elections?

Not very. The **2018 midterms** were followed by a selloff amid the Bitcoin Cash fork conflict; the **2022 midterms** coincided with the FTX collapse and a sharp BTC decline. Neither provides a clean election-volatility observation. The **2024 presidential election** produced a roughly 7% immediate BTC rally, but its policy stakes were different from those of a midterm election. The election-specific baseline is a genuine *known unknown*.

The practical comparator is the distribution of BTC moves around **CPI, FOMC, employment reports, major technology earnings and oil shocks in 2025–26**, measured from intraday spot data. The historical spot sample is not included in the trade tape, so **neither the 2.7–3.1% variance-equivalent shock nor a weekday-adjusted RV assumption establishes the edge**. Event-overlap matters as much as event identity.

Sources: [2022 FTX selloff](https://www.coindesk.com/markets/2022/11/09/bitcoin-falls-below-17k-amid-latest-ftx-meltdown) · [2018 Bitcoin Cash fork context](https://bitwiseinvestments.com/crypto-market-insights/crypto-market-update-november-2018) · [2024 election reaction](https://www.reuters.com/technology/bitcoin-leaps-record-high-traders-lean-towards-trump-victory-2024-11-06/).

---

## 2. Break-evens: connect the distribution to price targets

The chart's $80k-strike **long straddle** expiry break-evens are:

| Expiry | Downside | Upside | Interpretation |
|---|---:|---:|---|
| **6 Nov** | $76.6k | $83.4k | Approximate near-term range boundaries |
| **13 Nov** | $75.4k | $84.6k | Upper break-even beyond first resistance |
| **27 Nov** | $73.7k | $86.3k | Targets larger continuation moves |
| **25 Dec** | $70.9k | $89.1k | Requires a broader regime change |

Relevant technical areas: **$82–84k** first recovery resistance; **$86–88k** upper rally target; **$78–76k** first meaningful support; **$74–72k** breakdown target. These are scenario landmarks, not independently estimated probabilities.

**Important distinction:** straddle break-evens naturally widen approximately with $$\sigma\sqrt{T}$$. Their proximity to technical levels does **not** establish an edge. Their usefulness is in choosing a trade that pays at a *plausible target*, rather than paying for the entire tail beyond it.

The 6 November straddle break-evens describe **unhedged expiry P&L**. They are *not* the break-evens of a dynamically delta-hedged short straddle, whose result depends on the entire price path and hedge costs.

---

## 3. What the Deribit tape actually says

**Coverage:** 20,297 option-leg records from **24 October 00:24 to 29 October 00:24 UTC**. Excluding combo, block and liquidation records leaves **19,626 screen prints**. This is **five days**, not the requested two-week history; no two-week base rate can be inferred.

### The 13 November call cluster survives an initial consolidation

For the 13 November $84k, $85k and $86k calls:

| Measure | Result |
|---|---:|
| Individual screen prints | 318 |
| Buyer-aggressed prints | 277 (87%) |
| Buyer-aggressed contracts | **288.9 BTC** |
| Seller-aggressed contracts | **58.4 BTC** |
| Inferred execution clusters | **180** |
| Buyer-side execution clusters | **146 (81%)** |

The cluster rule joins **same-instrument, same-direction, consecutive `trade_seq` prints no more than one second apart**. This reduces fragmentation but is *not* a reconstruction of actual parent orders. Multiple clusters may belong to one execution algorithm; the observations remain autocorrelated.

**Read:** There was concentrated demand to buy these calls during the five-day window. The prior assertion that a raw 78% call-buy share signaled a bullish forecast was too strong. A meaningful flow signal needs comparison with historical, tenor- and moneyness-matched buy rates, followed by risk-factor markouts.

### December's $72k/$90k block: the sign matters

On 26 October, **14 paired blocks totaling 1,550 BTC per leg** printed a **December $72k put buy against a $90k call sale** in the dataset. Deribit documents block `direction` **from the maker's perspective**, unlike the taker direction convention used for screen trades. It is therefore wrong to interpret the label directly as a taker-buy signal.

An execution-price check is more revealing:

- **14/14** $72k put legs traded **above** the contemporaneous mark.
- **13/14** $90k call legs traded **below** the contemporaneous mark.
- The **put-buyer/call-seller side paid ~0.90 BTC** in aggregate relative to the paired leg marks (roughly $72k at prevailing spot).

That establishes which side paid *mark-relative edge*, not a predictive forecast or the identity of the initiator. It also puts **$90k December calls** on the watchlist as a possible overwriting concentration if BTC rallies into the upper $80ks. Fourteen tranches should not be treated as fourteen independent convictions.

Source for block-side convention: [Deribit Block Trading documentation](https://support.deribit.com/hc/en-us/articles/25944688627229-Block-Trading).

### How flow should be measured in the next version

Map every trade onto **three risk factors**, rather than treating each option purchase as a directional vote:

1. **Forward variance:** with $$w=\sigma^2T$$, $$\partial V/\partial w=\nu/(2\sigma T)$$. A bump to segment $$i$$'s annualized variance moves total variance by $$\Delta t_i$$ for each expiry beyond that segment. Sign exposure by the verified aggressor and aggregate by segment.
2. **Skew:** weight signed vega by standardized moneyness $$\log(K/F)/(\sigma\sqrt T)$$, or use 25-delta buckets.
3. **Direction:** aggregate signed delta; for a horizon-based drift proxy, compare $$\Delta\min(T,H)$$ with a specified holding horizon $$H$$, rather than treating a weekly and December 0.3-delta option as the same drift view.

Then compare **clustered, z-scored** cumulative flows with forward IV, 25-delta risk reversal and spot; test signed markouts after **5 minutes, 1 hour and 1 day**, plus lead-lag regressions. Keep negotiated blocks separate and check mark-relative execution edge. This requires a longer tape and timestamp-aligned surface data; the supplied CSV alone does not establish it.

---

## 4. Three structures and their scenarios

All prices are **illustrative Black-76 estimates** using spot $80,100, zero carry, the chart's expiry-specific ATM IV and a **flat smile**. They are **not executable quotes**. The tape itself shows material downside skew: December $72k puts printed near **40–41% IV**, versus ~36% ATM. For execution, reprice every leg on the actual Thalex mark surface and then on executable Deribit/Thalex bid–asks, including fees. A put spread can become cheaper when its short OTM put carries more IV; multi-leg crossing costs can consume the proposed edge.

### Trade 1 — Bullish: 13 November $82k/$88k call spread

**Buy the $82k call; sell the $88k call.** Target a relief rally through $82–84k toward $86–88k rather than paying for an unlimited upside tail.

| Metric | Indicative value |
|---|---:|
| Debit / maximum loss | **$1,227** |
| Expiry break-even | **$83,227** |
| Maximum gain, at or above $88k | **$4,773** |
| Profit at $85k expiry spot | **$1,773** |
| Flat-smile $$Q$$ probability of finishing above break-even | **~28.5%** |
| Initial net delta | **~+0.28 BTC** |

**Decision:** Prefer it if your subjective distribution puts enough probability on an $84–88k recovery. A bullish price forecast is insufficient by itself: calculate the **expected spread payoff under $$P$$** and compare it with the *executable* debit.

### Trade 2 — Bearish: 27 November $80k/$74k put spread

**Buy the $80k put; sell the $74k put.** Target a loss of $78k support and continuation toward $74k.

| Metric | Indicative value |
|---|---:|
| Debit / maximum loss | **$2,196** |
| Expiry break-even | **$77,804** |
| Maximum gain, at or below $74k | **$3,804** |
| Profit at $76k expiry spot | **$1,804** |
| Flat-smile $$Q$$ probability of finishing below break-even | **~40.4%** |
| Initial net delta | **~−0.28 BTC** |

**Decision:** Prefer it for a move toward $74–75k rather than a crash thesis. The $74k short put monetizes downside skew and caps the payout where the technical target sits. Again, the decision hinges on $$E_P[\text{payoff}]$$ versus the executable debit, not merely on the probability of finishing through break-even.

These two trades have roughly equal and opposite starting deltas. **Holding both is a different, long-convexity exposure** from either directional view; the three selections in this report are competing expressions of market views, not recommended simultaneous positions.

### Trade 3 — Volatility: sell the 6 November $80k straddle, delta-hedge

**Sell one $80k call and one $80k put; hedge net delta with BTC perpetuals.** Indicative premium: **$3,392 per BTC** at **36.1% IV**.

The P&L of a continuously hedged short option position is approximately

$$
\mathrm{P\&L}\simeq \frac12\int_0^T\Gamma_t S_t^2\bigl(\sigma_{\rm imp}^2-\sigma_{\rm realized,t}^2\bigr)\,dt-\text{hedging costs},
$$

with $$\Gamma_t$$ measured as the **positive gamma of the corresponding long options**. The realized path, particularly jumps near expiry, matters more than the terminal price. The short straddle has **unbounded upside tail loss** and substantial downside loss despite delta hedging.

#### A. The pre-election harvest: enter 29 Oct, decide on 2 Nov

This is the **preferred management plan to evaluate**, subject to an independently calibrated positive daily premium and executable pricing. Sell the straddle, hedge systematically, and set a **2 November pre-election review/exit**. The goal is to earn ordinary variance premium and possibly profit if *remaining* event risk is marked down before the election, without needing to carry the election gap itself. The academy brief adds a reason **not** to treat the intervening days as uniformly low-risk: early-week carry and Thursday/Friday earnings/macro repricing may be much less favorable than weekend diffusion.

**Calendar-adjusted carry.** For each UTC day or intraday interval, compare the actual *forward implied variance allocated to that interval* with a long-history, regime-adjusted spot RV estimate:

$$
E[\mathrm{P\&L}_d]\approx \frac12\Gamma_dS_d^2(Q_d-P_d)-\mathrm{hedge\ costs}_d.
$$

Here $$Q_d$$ and $$P_d$$ are **integrated variances over exactly the same interval**, not annualized full-expiry IVs. The 31 October 28.1% quote is **not** automatically the weekday or weekend forward implied-volatility quote. Extracting daily $$Q_d$$ requires shorter-dated curves or a calibrated variance-clock model.

For intuition only, suppose the independently estimated *full-week* diffusive RV is 30–32%. Using a weekend-to-weekday **volatility** ratio of 0.62 and preserving weekly total variance gives:

| Illustrative weekly RV | Weekday RV | Weekend RV |
|---|---:|---:|
| **30%** | **33.0%** | **20.5%** |
| **32%** | **35.2%** | **21.9%** |

These are calendar-allocation scenarios, **not output from a fitted 2024–26 spot model**. A 0.75 ratio instead gives ~32.1% weekdays / 24.1% weekends for 30% weekly RV. Historical lower weekend RV is not itself a risk premium unless the **implied** weekend variance clock falls by less. And the academy's macro catalysts make the ordinary weekday baseline potentially optimistic during this particular week.

The key accounting identity is:

$$
\underbrace{w_{\rm 29Oct\to6Nov}}_{\text{total initial variance}}
=\underbrace{w_{\rm 29Oct\to2Nov}}_{\text{variance consumed}}
+\underbrace{w_{\rm 2Nov\to6Nov}}_{\text{remaining event-inclusive variance}}.
$$

If ordinary **pre-event implied** volatility is approximated by 28.1%, and the full original election-event variance remains priced, then removing four quiet calendar days from the contract raises the 6 November option's **annualized exit IV from 36.1% to roughly 43.0%**. An exit quote **still at 36.1%** therefore indicates that the market has removed a meaningful amount of the event variance.

**Exit-IV sensitivity (legacy, not seasonality-adjusted).** The earlier model assumed *uniform* volatility across all four holding days and a 28.1% ordinary implied-volatility clock. Its 30% pre-exit-RV illustration produced approximately **+$243 per BTC** with exit IV held at 36.1%, versus **−$112** with exit IV at 43.0%, before option spread/fees/funding. **Those dollar estimates are not the expected P&L of the revised trade:** they do not allocate different variance to weekdays and weekends, do not use a representative fitted spot-RV forecast, and do not model the macro-event clustering identified by the academy brief.

The no-repricing exit IV also changes with the implied variance-clock assumption: **~43% is an illustration using uniform 28.1% pre-event IV**, not a market-independent prediction. The correct benchmark is an updated daily-forward-variance decomposition, which may imply a higher or lower exit IV depending on how much Thursday/Friday and weekend variance is removed from the option.

For the revised model, calculate *per-day gamma-weighted* carry using spot-history-based $$P_d$$; separately shock the remaining forward variance on 2 November, with 4-hour hedging, 2-bp hedge costs and option crossing costs. Until that is done, **no numerical pre-election EV is established**.

**Decision on 2 November:**

- **IV around 36%:** could indicate substantial remaining-event-variance compression *relative to a calibrated no-repricing forward-variance benchmark*; consider closing if realized hedge P&L and executable exit price confirm the gain.
- **IV near the calculated no-repricing benchmark:** event variance remains priced; the position has mainly earned or lost weekday-adjusted ordinary carry.
- **IV above that benchmark:** remaining event risk was marked up; the short can lose money even with quiet spot. Reassess the election gap rather than extrapolating theta.

A useful live dashboard would track **remaining total variance**, projected *no-repricing* IV, hedge P&L, and option-close value—not only current IV or theta decay.

#### B. If you carry it through the election

The original exercise used **26% ordinary RV** and a single election jump. Because 26% came from an unrepresentative five-day trade-data window, that calculation is **withdrawn as a calibrated trade recommendation**. A new holding-through-expiry simulation must use representative hourly spot data and distinguish (a) 29–30 Oct macro aftershocks, (b) low-diffusion but potentially gap-prone weekend, and (c) the election reaction. The election-night jump cannot be dynamically hedged away.

For orientation, the **entire 31 Oct–6 Nov forward-variance excess** is equivalent to a shock of approximately **3.1% at a 30% baseline**, or **2.7% at 32%**. Those shocks are smaller than the earlier 26%-baseline estimate; they are not clean *election-night* implied jumps. Holding through expiry requires an independently justified forecast of **total path variance including all clustered shocks**, not a comparison with a short historical sample.

**Trade selection:** The pre-event version is a forecast about **the path of implied event variance plus ordinary RV**. Holding to expiry is the stronger claim that **election-week realized variance**, including the jump, will be below its implied counterpart. Those are materially different theses.

#### Why not the straddle calendar as the main volatility trade?

The previously examined **short 6 Nov / long 13 Nov $80k straddle calendar** remains a useful *benchmark*, not a fourth recommendation. Its flat-smile indicative debit is about **$1,201**. At 6 November expiry with BTC pinned near $80k, its conditional P&L is roughly **+$1,950** if back-leg IV remains 35.6%, dropping to roughly **+$1,450** if that IV falls to 30%.

That calendar retains **post-election vega** and lowers worst-case upfront premium at risk, but the front-leg decay is most valuable if BTC stays near $80k. Its real edge requires both a favorable **spot distribution at 6 November** and a view on **13 November IV afterward**. The delta-hedged short straddle is the cleaner expression of a forecast that *weekday-adjusted* ordinary variance stays below its implied allocation and the remaining event premium may compress; it is also operationally harder and carries much greater gap risk if retained.

---

## 5. How to decide whether to put the trades on

For each directional vertical, compute:

$$
\mathrm{EV}_P=E_P[\text{expiry spread payoff}]-\text{executable entry debit}.
$$

Compare your **subjective physical distribution $$P$$** with the market-implied $$Q$$, using the entire spread payoff, not only a win-probability threshold. Then stress the result for skew and the cost of crossing both legs. The estimated $$Q$$ probabilities in the tables are model outputs, not probabilities inferred from recent trade flow.

For the short straddle, evaluate **two independent questions**:

1. How much **weekday-/weekend-adjusted** ordinary variance will realize from 29 October to 2 November, including the **Fed/PCE/GDP and AI-earnings aftershocks**? How does that compare with the daily *implied* variance clock, rather than full-expiry IV?
2. At what **remaining event variance / executable exit IV** can the position be closed on 2 November, and how much of the edge survives macro gap scenarios, hedging costs, option spread, and fees?

If the answer to (2) depends on exit IV staying near today's 36%, the trade is **partly an event-volatility repricing trade**, not simply theta harvesting.

### Remaining work before execution

- **Price the actual smiles and executable legs.** The CSV contains historical trade/mark observations, **not a synchronized current bid–ask surface**. Reprice the two verticals and short straddle at contemporaneous Thalex or Deribit bid–asks; include option fees and estimated hedge funding/slippage.
- **Estimate $$P$$ independently of the derivatives tape.** Use a representative **2024–26 hourly spot BTC history**, fit a 30/90/180-day volatility-regime forecast and hourly/day-of-week variance weights, and test event-day jumps around CPI, FOMC, AI earnings and geopolitical shocks. Reassess the **2.7–3.1% whole-segment variance equivalent** against that history.
- **Build the forward-variance flow series.** Expand to two weeks or longer, consolidate execution clusters, verify block-side conventions, and test markouts. Do not promote five days of print counts into a forecast edge.
- **Set short-volatility controls.** Define a loss budget, hedge tolerance, execution-failure behavior, oil/AI/rates-driven gap scenarios and the scheduled 2 November decision *before* entry. Carrying across election night should be a deliberate new risk decision.

## Bottom line

The directional structures are straightforward: **13 November $82k/$88k call spread for recovery**, **27 November $80k/$74k put spread for breakdown**.

The most interesting trade to test is the **6 November delta-hedged short straddle**, because it can be reviewed **before** taking the election jump. But the academy brief highlights a second source of danger: **weekday macro/AI/oil shocks may consume the premium before the weekend even begins**. The distinction is critical:

> **A quiet weekend is not a premium unless the implied variance clock overpays for it. Material pre-election gains are more likely to depend on compression of remaining event variance—and can be erased by macro gaps before Monday.**

The decision requires **daily physical-versus-implied variance** and a model for **how all remaining macro/election variance reprices**. A raw threshold such as “RV below 30%” is insufficient, particularly when the pre-election period spans weekdays, a weekend and overlapping macro catalysts.

---

*Data and methodology: user's BTC ATM term-structure and $80k straddle charts; uploaded Deribit BTC option-leg CSV (24–29 October 2026), **used for flow only**; supplied Harmonic Academy “The Opener — Monday — The Week Ahead” brief (26 October), selectively integrated with 28–29 October public-release updates. Historical volatility seasonality references are external spot-return studies, **not a fitted forward-RV model**. Pricing is timestamp-specific, illustrative Black-76. No current executable order-book snapshot, fully calibrated 2024–26 spot-history RV model, or complete macro-event return dataset was supplied.*
