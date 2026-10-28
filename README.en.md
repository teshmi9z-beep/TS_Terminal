# TeshTerminal

*Version française : [README.md](README.md)*

**A free, self-hosted trading terminal that runs in your browser, TradingView-style.** Live charts for crypto, forex, indices, futures and stocks, your own Pine Script indicators and strategies, a backtester, bar replay, paper trading and a lab that tests trading robots with real costs. Built with React, TypeScript and TradingView's Lightweight Charts™. Interface in English and French.

![Chart with Bollinger Bands, RSI and MACD, watchlist and asset details](docs/screenshots/chart.png)

### Features

- **Charts**: candles, Heikin Ashi, bars, line, area; ticks, seconds, minutes, hours, days; 1, 2, 4 or free windows; detached windows on several screens; drawings, Fibonacci, volume profiles, position tools, magnet.
- **Live data with no API key**: Binance (crypto, ticks), Yahoo Finance (stocks, indices, forex, commodities), Interactive Brokers through IB Gateway (optional), real-time estimate of the CME index futures.
- **Indicators**: built-in ones, indicator on indicator, and a **Pine Script v5/v6 interpreter** to paste TradingView scripts.
- **Strategies**: a guided builder (no code) or Pine Script, a strategy tester with dashboard, trade list, calendar and equity curve.
- **Replay and paper trading**: replay the market bar by bar, place orders on the chart, a virtual account with SL / TP.
- **Alerts**: on price, indicators, several conditions or a whole watchlist, with Windows notifications.
- **Market tools**: stock screener, heatmaps, economic / earnings / dividend calendars, news, options chain and strategy builder, yield curves, Macro Maps, fundamentals, portfolios.
- **Robot lab** (Node, outside the browser): searches entry rules on years of history since 2020, with real costs, tuning / validation split and walk-forward, and publishes the robots that hold.
- **Offline**: the bars of every chart are saved in the browser; charts, replay and tester work without a connection.

| Strategy tester | Trading robots |
| --- | --- |
| ![Strategy tester](docs/screenshots/strategy-tester.png) | ![Trading robots](docs/screenshots/robots.png) |
| **Heatmap** | **Options chain** |
| ![Stock market heatmap](docs/screenshots/heatmap.png) | ![Options chain](docs/screenshots/options.png) |

> **Disclaimer**: this is a personal project for learning and paper trading. It is not financial advice, places no real orders, and past results do not guarantee future results. Market data comes from free public sources that may be delayed, incomplete or change without notice. Not affiliated with TradingView, Binance, Yahoo or Interactive Brokers.

## Getting started

Double-click `lancer.bat`: the server starts, then the platform opens in Chrome in **app mode** (no tabs or address bar, detached windows included). Otherwise:

```bash
npm install
npm run dev
```

then open http://localhost:5173.

Yahoo Finance data goes through the Vite server's proxy (`/yf`, see `vite.config.ts`), so the app must be served by `npm run dev` (or `npm run preview`), not opened as a plain file.

## Language

The **EN / FR** button (globe icon, top right) switches the interface between English and French. The page reloads in the other language and the choice is remembered, detached windows included. On a first visit the language follows the browser's (French if the browser is in French, English otherwise).

How it works: the screens are written in French, and in English every displayed text is swapped on the fly from `src/i18n/en.json` (`texts`: whole texts, `patterns`: texts with values `{0}`, `{1}`…; `null` = leave as is). This covers tooltips, fields, texts drawn on the charts and the browser's alert / confirm boxes. Numbers and dates follow the language (`LOCALE`, `DEC` in `src/i18n/lang.ts`), and news and TradingView profiles are requested in English. In French the dictionary is not even loaded. After adding screens, list the texts that have no English yet:

```bash
node scripts/i18n-extract.mjs --broad
```

then fill `en.json` with what it writes to `scripts/i18n-missing.json`. An element marked `translate="no"` is never translated. Texts that come from data (robot lab reports, company names) stay as they are.

## Data sources

| Market | Source | Updates |
| --- | --- | --- |
| Crypto (USDT pairs) | Binance (REST + WebSocket, no key) | real time |
| Tick charts (1T to 1000T), crypto | Binance spot `aggTrades` + WebSocket `aggTrade` | real time |
| Tick charts, gold / silver / WTI oil / gas / copper and ~160 US stocks and ETFs (TSLA, NVDA, AAPL, SPY, QQQ…) | Binance Futures "TradFi" perpetuals (`XAUUSDT`, `TSLAUSDT`…), labelled "Binance perpetual" | real time; price of the perpetual contract, which trades 24/7 and can drift from the underlying outside the session; history limited to 2 days; does not feed the symbol's quote |
| Stocks, indices, forex, commodities | Yahoo Finance | polled every 4 to 30 s, may be delayed depending on the exchange |
| Interactive Brokers index CFDs: IBUS30, IBUS500, IBUST100, IBDE40, IBFR40, IBJP225, IBHK50 ("CFD" section of the main list); DAX, CAC 40, Hang Seng futures (DE40, FR40, HK50, "Future" section) | IB Gateway running on this PC (port 4001 or 4002, or TWS 7496 / 7497, found automatically; "Read-Only API"), relayed by the Vite server (`/api/ib`, `scripts/ib-relay.ts`) | delayed 15 min without an IBKR subscription, real time with one; history since 2012; nothing if the Gateway is closed; DE40 and HK50 get the same **real-time estimate** as the US futures (next row), from BingX `NCSIGER2USD-USDT` and MEXC `HK50_USDT` |
| Indices trading 23 hours a day: US30, US500, US100 ("Future" section of the main list) | real CME futures (YM, ES, NQ) through IB Gateway, expiries put end to end; Yahoo (`YM=F`, `ES=F`, `NQ=F`) if the Gateway is closed | real time with IBKR's "US Securities Snapshot and Futures Value Bundle" (USD 10 a month, waived from USD 30 of commissions in the month), otherwise 10 min late, filled by a **real-time estimate**: last delayed CME price × move of the Binance (`SPYUSDT`, `QQQUSDT`), MEXC (`SPX500_USDT`, `US30_USDT`, via `/mexc`) and BingX (`NCSIDOWJONES2USD-USDT`, via `/bingx`) perpetuals since that minute (`src/data/feeds/futuresEstimate.ts`); purple dot, estimated candles shown pale and replaced by the real ones as they arrive; median gap measured over 14 days: ES 0.5 pt, NQ 2, YM 2.7 (against 2.3, 15 and 16 with the delay); stops by itself once IBKR goes real time; charts and list only (robots, alerts and saved history keep the real bars) |
| US2000, J225 ("Future" section) | Yahoo CME futures (`RTY=F`, `NIY=F`), nearest expiry | 10 min late, filled by the real-time estimate (BingX `NCSIRUSSELL20002USD-USDT` and `NCSINIKKEI2252USD-USDT`; fallback Binance `IWMUSDT` and MEXC `JP225_USDT`): median gap 0.25 pt on RTY, 11 on NIY (against 1.1 and 55); price above the cash by the carry cost; DAX, CAC 40 and Hang Seng come from Interactive Brokers (row above) |
| Everything else / offline | local simulator | "simulated display" banner |
| Symbol info (sector, website, sessions) | Yahoo Finance `quoteSummary` via `/api/yinfo` (token handled by the Vite server) | on opening |
| FIGI | OpenFIGI (Bloomberg) via `/figi` | on opening |
| Yield curves (sovereign rates) | TradingView public screener via `/tvscan` (`TVC:FR10Y`… symbols) | every 60 s |
| Stock screener (France, United States, Germany…) | TradingView public screener via `/tvscan`, TradingView logos | every 60 s |
| Macro Maps (inflation, rates, GDP…) | TradingView screener (`ECONOMICS:FRIRYY`…); history: World Bank (annual), BIS (policy rates, monthly) | on opening |
| Markets, options (OPRA), fundamental charts, earnings and dividends | TradingView public screener via `/tvscan` | every 60 s / on opening |
| Economic calendar | ForexFactory public feed via `/ffcal` (current week; no "actual" value) | every 10 min |
| News flow (in the interface language) | TradingView `news-mediator` / `news-headlines` via `/tvnews` and `/tvstory` | every 60 s |
| Community scripts | TradingView search via `/tvweb`, source code of open-source scripts via `/tvpine` | on demand |

Ticks: one bar = N aggregated Binance trades, timestamped to the millisecond (several bars per second in 1T). Trades are loaded in pages of 1,000 aligned on their id and kept in memory (400 pages): the other tick intervals of the same symbol and the strategy tester reuse them. Loading stays under a request-weight budget per minute (spot 2,400 out of 6,000, futures 1,200 out of 2,400) and stops for 30 s after a failure, so Binance does not ban the IP. The other markets (forex, indices, CME futures, non-US stocks) have no free ticks: they are simulated (with an explicit banner).

Timeframes: ticks (Binance), seconds (Binance), minutes / hours / days. Timeframes a source does not provide directly (45m, 2H, 3H, 10s…) are rebuilt from a finer one; for stocks, hourly bars are aligned on the session open, as on TradingView.

Yahoo history limits: 1 min = 30 days, 5–30 min = 60 days, 1 h / 4 h = 2 years, daily and above = everything.

## Shortcuts

- Type a letter anywhere: symbol search
- Double-click the chart: auto scale + back to the last bar
- Mouse wheel on the price axis: vertical zoom
- Del: deletes the selected drawing, Esc: cancels the current tool
- Chart settings (gear at the top): countdown to the candle close (on / off)

Charts: TradingView Lightweight Charts™, Copyright © 2025 TradingView, Inc., https://www.tradingview.com/ (the library's logo is hidden on the charts).

## Detached windows (several screens)

- ↗ button in the top bar, ••• menu › "Open in a new window", or ↗ on a window in Free mode: the chart opens in a real browser window that can be moved to any screen.
- Dragging an asset from the list on the right **outside** the browser opens a window there.
- "Layout › Choose the screen…" opens directly on a given screen (Chrome asks once for the "Window management" permission).
- Each window keeps its own state (symbol, timeframe, indicators, drawings); "Layout" lists the windows, reopens them in place or closes them all. Allowing pop-ups for localhost lets them all reopen at once.

## Free mode

Dragging an asset from the list on the right into the central area opens a window there; dropping it on a chart (1, 2 or 4-window mode) changes that chart's symbol.

In 2-window, 4-window or Free mode, each small chart takes the indicators of the main window (the one of 1-window mode): same list, same settings and colors, computed on its own symbol and timeframe. Adding, removing or tuning an indicator in 1-window mode also changes the small charts. Each small chart has the same legends and controls as 1-window mode: name, OHLC and values under the crosshair, eye (hide / show), source code, settings, removal, and for panes move up / down / collapse / maximize / delete. What touches indicators (settings, hiding, collapsing a pane, removal) applies to all windows; "maximize" only applies to the window where it is clicked. Small charts open in the main window's timeframe (15 min if it is a tick timeframe).

**⛶ (header of a small chart)**: shows it alone and large in the main window (1-window mode), with its asset and timeframe. A "↩ Back to the free windows" (or "to the 4 windows") bar brings back the previous layout; ✕ closes it to stay in 1 window. Each small chart (Free, 2 and 4 windows) keeps its asset and timeframe when you change layout and come back.

Right-clicking a small chart (or "•••" in its legend) opens the same menu as in 1-window mode, for its own asset and last price: alert, indicator, symbol info, copy the price, hide this chart's candles, add to a list, open in a new window, setups. Only the text note is missing: small charts do not show drawings.

## Chart colors and themes

- ⚙ Chart settings: each color (body, borders, wicks, background, grid) is picked in one click among 10 ready-made colors, or in the full picker (palette, custom color, opacity). These 10 colors also head every picker (indicators, drawings).
- The light and the dark theme each keep their own colors: switching from one to the other brings back the settings left in each theme. "Default colors" restores the original ones of the theme shown: light = grey up candles with a black border, black down candles; dark = grey up candles, red down candles.
- A saved template (💾) keeps the colors of both themes.

## Offline data

The bars of every opened chart (history, older pages and real time) are saved in the browser (IndexedDB, about 48 bytes per bar). Without a connection, the charts, the replay, the strategy tester and the screener use this data. A banner says so, and an "Offline" badge shows in the tab bar. A missing timeframe is rebuilt from a finer one (5m from 1m, 4H from 1H, week from day). The chart goes live again as soon as the network is back. Online, when the source has no more history (Yahoo: 30 days in 1 min), scrolling into the past continues with the bars saved on previous days.

The charts also use the robot lab's history (`robots/data`, served by the development server under `/api/data/lab/page`): for a symbol and timeframe it holds (or a finer timeframe that divides it: 2H from 1H, week from day), scrolling into the past continues in its files once the online source is exhausted, for example forex in 1 min since 2000 (HistData) behind Yahoo's 30 days. In crypto, the Binance files are the same bars as the API: old pages are read from disk as soon as the file reaches the last loaded bar, with no request to Binance. A file only extends the chart if it reaches the oldest bar shown (a few days apart at most): a history that stopped years earlier (HistData's Euro Stoxx 50, ended in 2019) is not stitched on. Without network, a chart opens on that same history if it goes further back than the bars saved in the browser. The Binance perpetual files (`bnfut_`) are only used by the lab.

••• (tab bar) › **Offline data…**: turn automatic saving on or off, download in advance the history of symbols of the list in several timeframes (up to 10,000, 50,000 or 200,000 bars per series), see and delete what is saved. Ticks and seconds are limited to the last 200 blocks per series. The app itself runs locally (`npm run dev`), so without Internet.

## Asset info (like TradingView)

**On the chart**, at the bottom: **E** (earnings), **D** (dividends), **⚡** (news). On hover, a card:
- **E**: date (☀ before the open, ☾ after the close), period, reported / estimated EPS / surprise, reported / estimated revenue. The next earnings are dotted, to the right of the last candle. "See all results" opens Fundamental charts on the company (EPS).
- **D**: ex-dividend date, payment date, amount.
- **⚡**: the asset's latest news (TradingView), clickable.
- Chart settings › "Events at the bottom of the chart": show each type or not.

**Under the list on the right**, the asset's details: sector and industry, price, day and 52-week range, latest news, next earnings (date, estimated EPS and revenue), dividends (payout ratio, yield, last payment, dates), analyst rating (gauge, number of analysts, 1-year target). The line above the details can be dragged up or down to enlarge the details or the list.

Sources: TradingView screener (details, latest and next earnings, dividends, analysts), Yahoo (all dividends, earnings dates up to mid-2025, via `/api/yearnings`), Nasdaq (last 4 earnings of US-listed stocks, via `/nasdaq`), TradingView news feed. Code: `src/data/assetInfo.ts`, `src/components/ChartEvents.tsx`, `src/components/SymbolDetails.tsx`.

## Drawings: templates and favorites

- ◧ in the left toolbar: drawing templates (tool + color + width + line style), or ☆ in the mini-bar of a selected drawing to save its style.
- Right-click a tool › Add to favorites; ★ shows the floating favorites bar (movable by ⋮⋮).
- **Fib level**: default setting (29 September) = levels 0, 0.382, 0.5, 0.618, 0.786, 0.88 and 1, a single blue color, 1 px dashed lines, no background, level values on the left, without the prices.
- **Colored tools** (29 September): each tool family has its color in the left bar, the favorites bar and the menus, with a darker shade in the light theme. Segments and rays in blue; horizontal lines in the color they draw (yellow, blue, red, green); rectangle and templates in purple; brush in pink; text in cyan; Fibonacci with colored levels; volume profiles in indigo, with the POC in yellow; positions in green (target) and red (stop); yellow ruler; red magnet when active; red trash can. The active tool gets a background of its color. Code: `tone` in `src/components/toolInfo.ts`, `tone-…` classes in `App.css`.
- **Magnet** (horseshoe in the left bar), as on TradingView: the points of a drawing stick to the open, high, low or close of the candle under the mouse, and to that candle's time.
  - Click: on or off; right-click: **weak magnet** (only when the mouse is less than 24 px from one of these prices) or **strong magnet** (always the nearest price). Filled poles on the icon = strong magnet.
  - A blue ring shows where the point will stick. The magnet works when placing a point and moving a point of a drawing; not with the brush, the text, or when moving a whole drawing.

## Replay

**Replay** button: click a bar of the chart (or 🎲 "Random" for a random date), then play / pause, step one bar forward (Shift + →), speed from 0.1x to 10x, "Real time" to exit. The replay keeps its date if you change timeframe or symbol.

## Custom indicators (Pine Script)

- Right bar › **Pine editor** (or Indicators › "New Pine script"): paste a Pine v5/v6 script; it compiles and runs a trial on the last 500 bars live; "Add to chart" (Ctrl+S saves).
- Supported: `input.*`, `ta.*` (sma, ema, rma, rsi, stoch, macd, bb, atr, supertrend, pivots…), `math.*`, `color.*`, `var`, `if` / `for` / `while`, user functions, `plot`, `plotshape`, `plotchar`, `hline`.
- Strategies (`strategy(...)`, `strategy.entry` / `exit` / `close`…): see "Strategy tester" below.
- Not supported: `request.security`, arrays (`array.*`), `switch`, types / methods. `bgcolor`, `fill`, `label`, `line`, `table` are ignored (a warning is shown).
- The `{}` button of the legend shows the code; "✎ Edit" reopens it in the editor.
- Built-in indicators written in TypeScript: `src/indicators/` (e.g. `custom/stochPriceEnvelope.ts`).

## My indicators (ported from Pine Script)

Indicators › "My indicators"; the `{}` button shows the original Pine script and its port.

- **Custom Imbalance**: bullish / bearish fair value gaps as boxes (colors and border adjustable).
- **Imbalance**: yellow blocks on the imbalances of the middle candle (adjustable transparency).
- **HA**: cyan / red alternative candles over the chart (linear regression, Heikin Ashi or none). To see only them, hide the main series (the symbol's ••• menu).
- **Sessions**: dotted New York / London / Tokyo boxes (GMT+1 hours adjustable) with high / low, intraday timeframes only.
- **Sto+RSI**: slow stochastic (K 200 smoothed 3, D 200 green / red by its slope, levels 80 / 20) and RSI 14 (70 / 30).
- **Tsh_Arrow**: SuperTrend on a volume-weighted average (WMA 20 by default, factor 4), colored by a KNN vote (up / down / neutral), zone between the SuperTrend and the candles' middle, trend-start dots, signal triangles and ▲ / ▼ arrows on DEMA MACD crossings (the last 50, like `label.new` on TradingView).

As on TradingView, boxes keep the 500 most recent (`max_boxes_count`).

### Market structure (Dow) · price action

Made for the platform (no original Pine script): Indicators › "My indicators" › "Market structure (Dow)". Code: `src/indicators/custom/dowStructure.ts`.

- **Highs and lows**: a high exceeds the N candles on each side ("Strength" setting, 3 by default). It is only known N candles later, as on a real chart. HH / HL labels (green) and LH / LL (red).
- **The two levels**: the last high and the last low not broken yet (staircase lines).
- **Trend**: a clear close above the high turns it bullish, below the low bearish. A clear close is a candle in the direction of the break, with a body of at least 50 % of its height (adjustable). The label says "BOS" when the trend continues, "CHoCH" when it reverses. Light green or red background (adjustable transparency).
- **Retracement box**: the last opposite candle at the origin of the leg that broke the level, like an institutional block (the low of the rise, the high of the fall).
- **Entry** when the price comes back into the box, on touch or on a rejection candle (adjustable). "Buy" or "Sell" arrow. A box is used only once.
- **Stop** below the box (above for a sell), with a 0.1 ATR margin.
- **Target**: the next liquidity, at least 1 R away (adjustable). That is an equal high / low or a high / low not taken yet.
- **Exit**: orange "Exit · stop / target / reversal" arrow with the result in R. "Reversal" means a clear close the other way. For the current trade: entry, stop and target lines.
- **Liquidity**: equal highs / lows (EQH / EQL), that is two or more highs or lows less than 0.15 ATR apart (adjustable). The dotted line runs until the price takes it. "Liquidity taken" if the candle comes back to the other side of the level.
- **Ranges**: the last two highs and the last two lows are each less than 0.5 ATR apart (adjustable). The range is drawn as a grey box until a clear close outside.
- Nothing reads the future: the indicator computed on a cut history gives the same arrows up to the cut.
- **Options added for the night study** (same engine as the study, `src/robots/dow.ts`, hence the same trades):
  - **Entry signal**:
    - "Return into the box after a break";
    - "Liquidity grab then return". The price takes an untaken high / low (or an equal high / low) with a wick and closes on the other side: counter-trend entry at the close, stop behind the wick.
  - **Box**:
    - last opposite candle (block);
    - half of the leg (50 %);
    - return below the broken level, that is the former range.
  - **Target**: next liquidity, fixed multiple of the risk, none (exit at reversal), or trailing stop under each new low (above each high for a sell), the Dow way.
  - **Liquidity**:
    - no trade when liquidity lies near the stop;
    - stop placed beyond that liquidity;
    - or only after a liquidity grab (the leg first hunted the stops).
  - **Other settings**:
    - stop at the entry price after +1 R;
    - minimum impulse in ATR;
    - box lifetime.
  - **Filters**:
    - active hours (Paris time, for example "8-12, 14-18");
    - trend direction of the higher timeframe (1 h, 4 h, day, or 20 candles on a tick chart);
    - costs per side (results in R become net);
    - no trade when costs exceed a percentage of the risk;
    - no entry when the price is in a range.
  - **Summary** near the last candle: number of trades, total in R and share of winners over the history shown (costs included when set).

### Indices: "Future / cash basis" and "Opening gap"

These two indicators work on the indices of the main list, whether the chart shows the cash (SPX500, DAX40…), the future (US500, DE40…) or the CFD (IBUS500, IBDE40…). Each index is linked to its two other versions in `src/data/indexFamilies.ts`, with the hours of its cash session and its future's expiry rule.

**Future / cash basis** (pane):
- **Spread**: future minus cash (or minus the CFD, "Compare the future with" setting), in points or in %. Blue above zero (contango), orange below (backwardation).
- **Theoretical spread**: what the carry costs until expiry, cash × (rate − dividends) × days / 365. Default rates and dividends depend on the index and can be changed.
- **Premium** (optional): spread minus theoretical.
- The legend sums up the last value: contango or backwardation in points and in %, implied annual carry, expiry and days left.
- The other series loads in the background (`src/indicators/companion.ts`). Above 15 min, the spread is measured on aligned 15 min candles (the hourly candles of the US cash start at :30). The cash candles outside the session, including the closing auction one, do not count.

**Opening gap** (on the price):
- A zone between the previous close and the cash open, until it fills (solid border) or until the end of the session (dotted), with the text "Gap +0.62 % · filled in 45 min".
- All loaded sessions by default ("Sessions shown" setting, 0 = all): going back in the chart, older gaps appear. Overlapping texts are hidden, the most recent kept.
- In daily, on the cash: each gap extends until the day it fills ("filled after 3 d") or stays open until today ("still open"). This is the way to see gaps over years, as Yahoo's intraday only goes back 60 days in 15 min.
- On the last session: the odds of filling measured by the gap study since 2020 for this index, this direction and this gap size (within the hour, by the close, median time).
- Outside the session:
  - on the cash, the **expected open**: its close plus the future's move since that close;
  - on the future or the CFD, the **cash gap forming**.
- On a future or a CFD, only the candles of the cash hours count for the sessions.

## Indicator settings

Gear of an indicator in the legend: a window like on TradingView.

- **Inputs**: grouped and on one line as in the Pine script (`group=`, `inline=`), session hours in two time fields.
- **Style**: for each plot, show / hide, color **with opacity** (palette, custom color, opacity slider) and width; horizontal levels of the panes.
- **Visibility**: timeframes where the indicator is shown (ticks, seconds, minutes, hours, days, weeks, months, with a range).
- **Configure ▾**: reset, save as default (applied at each new addition), forget the default.
- Changes apply at once; **Cancel** (or Esc) goes back to the settings from before opening.
- **Source** (SMA, EMA, WMA, ZLEMA, Bollinger, RSI, MACD, CCI, Momentum): a price (close, open, high, low, hl2, hlc3, ohlc4, hlcc4, volume) or the line of another chart indicator, as on TradingView.

## Indicator on indicator

- **ƒ+** button in an indicator's legend: adds an average, a Bollinger, an RSI… computed on its line (choice of the line when there are several, e.g. MACD: histogram, MACD or signal).
- An average or a Bollinger goes into its source's pane (average of the RSI in the RSI pane); an oscillator gets its own pane (RSI of the OBV).
- The title says what it is computed on: "SMA 20 · RSI 14", "BB 20 2 · MACD 12 26 9 (Signal)".
- Deleting the source also deletes the indicators computed on it.

## Alerts

Bell icon of the right bar (or the "Alerts" button at the top).

- Quick **price alert**: typed price (empty = current price), Alt+A, or the bell tool of the drawing bar. The asset's price is followed even if it is on no chart and not in the open list.
- **Alert on indicator, several conditions or list** (panel button, or the bell 🔔 in an indicator's legend):
  - on one asset, or on each asset of a watchlist (60 at most), in the chosen timeframe;
  - up to 5 conditions, all on the same bar or at least one;
  - each condition compares the price, an indicator line or a value: crosses (up / down), greater / less than, enters a channel / exits it / inside / outside, rises / falls by X % in N bars;
  - trigger: only once, once per bar, or on bar close;
  - no expiry or until a date; optional name and message; optional Windows notification.
- Indicators are copied into the alert with their settings at creation time.
- In the panel: status of each alert (standing by, triggered N times, stopped, expired), ⏸ / ▶, ✎ to edit it, ✕; **Log** of the last 300 triggered alerts (click the asset to open it).
- Alerts run as long as the platform is open, even minimized or in the background. Platform closed or PC off: no alert.

## Indicator panes

- Drag the divider between two panes to resize them (size remembered)
- Buttons at the top right of each pane: move up, move down, collapse, maximize, delete
- "Window layout › Reset the default sizes" restores the original heights
- Gear of an indicator in a pane › Horizontal levels: add / remove lines (e.g. 80, 70, 30, 20)

## Right sidebar

A strip of icons like TradingView, one panel at a time (width adjustable by the left edge): watchlist, active alerts, data window (values of the bar under the cursor), screener (CAC 40 / S&P / crypto… lists, sorting, filters, daily RSI), Pine editor, yield curves, Macro Maps.

- Help bubble to the left of each icon on hover.
- ⛶ at the top right of each module (next to ✕): full screen, as on TradingView (Esc to go back).
- ⇤ in the watchlist header: moves it to the left of the terminal (⇥ to put it back on the right); the list's icon in the strip shows / hides it.

## Yield curves

Right bar › **Yield curves**, like the TradingView widget:

- **Chart**: government yield curves from 1 month to 30 years (by default France now, 1 month ago, 1 year ago); hover = values of the maturity under the mouse, ⌃ button to fold the legend.
- **Compare yields**: table by maturity; colored box = show / hide, click on the country = change country or period (current, 1 week, 1 / 3 / 6 months, start of year, 1 year), duplicate, delete, "Add".
- **Map**: 10-year yields by country (scale 1 % – 5 % – 20 %); click a country to show its curve.
- Gear: maturities proportional to the duration or evenly spaced, points, refresh. Camera: PNG image.
- Past curves are derived from the change of each rate over the period (the screener's `Perf.*` field).

## Screener

Right bar › **Screener**, like TradingView's "Stock screener":

- Market (France, United States, Germany, United Kingdom, Italy, Spain, Switzerland, Netherlands, Belgium, Canada, Japan); all stocks (largest market caps first).
- **Table** with *Overview*, *Performance*, *Valuation*, *Technicals* views (sort by column), or **Heatmap** by sector (size = market cap, color = day change).
- **Filters**: sector, market cap, price, change, RSI, relative volume. **Save** stores the screen (filters, view, market), recalled from the "All stocks ▾" menu.
- Click a stock: it opens on the chart (Yahoo Finance prices); ＋ adds it to the watchlist.
- "Stock screener ▾ › List screener": the former screener (watchlist, crypto, forex, indices, RSI).

## Macro Maps

Right bar › **Macro Maps** (globe icon), like TradingView: a world map colored by inflation rate, interest rate, GDP, or (••• menu) GDP growth, unemployment, government debt / GDP, current account / GDP, population.

- Mouse wheel or + / − buttons to zoom, drag to move, ⤡ to go back to the overview.
- Time slider: goes back through history (loaded on the first move); "back to today" for the latest values.
- List at the bottom: G20, G7, European Union or World, ranked by value, with the TradingView symbol and the observation date; 🔍 filters by country or symbol.

## Strategy tester

Panel under the chart (**Strategy editor**, **Strategy tester**, **Virtual trading** tabs): height adjustable by its top edge, ⛶ to enlarge it, ⌄ to fold it.

**Strategy editor**, two ways to create a strategy:

- **Guided builder** (like ProRealTime): *Buy*, *Sell* (long exit), *Sell short*, *Buy to cover* blocks. "Add a condition", then click an element: **Select on the chart** (click a line or its legend, the symbol = the price), an indicator already on the chart, the price, a value or another indicator. Conditions: crosses up, crosses down, is greater than, is less than, is rising / falling; AND / OR. *Stops & targets*: stop at the low / high of the last N candles, in %, in points or ATR × k; target as a risk / reward ratio (1, 2, 3 or other), in % or in points. *Money management*: risk per trade in % of capital, % of capital, fixed amount or quantity, capital, commission, execution (next open or signal close), reversal on an opposite signal. "Generated code" shows the equivalent Pine script (usable on TradingView); "Edit as code" makes it editable.
- **Pine Script code**: `strategy("…")` with `strategy.entry`, `strategy.exit` (stop / limit / loss / profit), `strategy.close`, `strategy.close_all`, `strategy.cancel`, and `strategy.position_size`, `strategy.equity`, `strategy.position_avg_price`… The script's `input.*` parameters are set in the right column.

First example provided in two versions: **MA cross 10/50** (guided) and **MA cross 10/50 (Pine)** — buy when the 10 average crosses above the 50, sell short when it crosses below, stop under the low of the last 3 candles, R/R target 1 (or 3), 1 % of capital risked per trade. Both give exactly the same backtest.

**Strategy on the chart** (like TradingView): "▶ Run the backtest", or Indicators › My scripts › Strategies, adds the strategy to the chart: its price indicators (e.g. the two moving averages) are drawn there with the trades. It has its line in the legend: eye = hide, gear = strategy editor, trash can = remove it from the chart (the tester's "on the chart" box does the same).

**Strategy tester** (ProRealTime's report): reruns by itself when the strategy, the symbol or the timeframe changes.

- **Dashboard**: profit, % winning trades, win / loss ratio, average gain (max and average gain / loss), trade breakdown, gross profit and loss, max drawdown and runup, time in market, orders executed per day, gross performance per day / week / month.
- **List of closed positions**: dates, type, number of bars, absolute and relative perf, MFE, MAE, unit gain (sort by column; click a row = the trade on the chart).
- **Calendar performance** (months × years) and **Equity curve** with the positions histogram.
- Filter all trades / long / short positions, number of bars loaded (1,000 to 20,000), trades shown on the chart.
- TradingView-style order simulation: market orders filled at the open of the next candle, stops / targets tested within the candle (the extreme nearest the open first), one position at a time.

## Virtual trading

Paper portfolio (100,000 to start, can be reset): market, limit or stop orders, stop loss / take profit.

- **Trade** button at the top right (above the list): order ticket.
- **Virtual trading** tab under the chart: capital, balance, P&L, then positions (SL / TP editable, close), pending orders and history.
- Positions and orders show on the chart; quick SELL / BUY buttons at the top left of the chart when the ticket or the tab is open. P&L is in the symbol's currency.

## Workspaces

**Workspaces** menu: save the whole layout (main window + detached windows on all screens), load it again, assign it an F1–F10 key, export it as `.teshws.json` to share it, and import it. "Undo the last load" goes back to the previous layout.

Loading a workspace (menu, F key, or the layout on the "New tab" page) reopens its detached windows in their place and size, including on another screen. Two Chrome settings, once:
- **Window management**: Chrome asks for it when saving a workspace that has windows on another screen; without it, Chrome brings the windows back to the main screen.
- **Pop-ups**: without permission, Chrome opens only one window per click; the others wait in the bar at the bottom ("Open the N windows"). To open everything at once: `chrome://settings/content/popups` › "Allowed to send pop-ups" › Add `http://localhost:5173` (app mode has no address bar, so no blocked pop-up icon). If window management was refused: `chrome://settings/content/windowManagement`, same steps.

A window closed by hand stays in the workspace: it comes back at the next load. To remove it, "Save" the workspace without it.

## Trading robots

**Trading robots** tab ("New tab" page): the most profitable strategies found by the lab, each with its report. Criteria: more than 50 % winning trades and a win / loss ratio (average gain / average loss) above 1.3, over the tuning period **and** the validation period.

- **A robot** = an entry signal taken from your indicators (Tsh_Arrow, ZLEMA, Stoch Price Envelope, Sto+RSI, Imbalance, HA), a regime filter to avoid ranges (ADX, Choppiness, Kaufman efficiency, ZLEMA direction, Tsh_Arrow SuperTrend, Stoch Price Envelope "staircase", sessions), a stop (ATR or last low / high) and a direction (long, short or both).
- **3 entries per signal, 0.3 % of capital each** (capital €10,000): A fixed (fixed stop and target), B trailing (at each R reached the stop moves up a notch, plus an ATR trailing stop), C steps (a third at 1 R, 2 R and 3 R, stop at break-even after 1 R then at +1 R after 2 R). An opposite signal closes and reverses.
- **Realism**: entry at the open of the next candle, stops and targets tested within the candle (open → nearest extreme → other extreme → close), costs + spread + slippage per side depending on the platform where the market trades (`costOf`): Binance spot 0.1 %, Binance Futures 0.06 % (0.05 % commission plus the spread), major forex 0.01 %, crosses 0.02 %, kronor/kroner and zloty 0.04 %, lira, rand and peso 0.08 %, gold / silver / oil at a broker 0.03 %, indices 0.02 %, stocks 0.05 %. Until 25 September 2026 the lab counted far less (0.01 % for gold or oil, 0.004 % for all forex), and some tight-stop intraday robots only looked profitable thanks to that.
- **Forex rollover**: HistData only gives the bid price; at rollover (around 5 pm New York) the spread explodes, the bid dives and only comes back when the spread narrows, around 6 pm. This dip cannot be traded (buying pays the wide spread): for candles of one hour or less, those touching 4:45 – 6:15 pm New York give no entry and no exit, and no hour-range breakout is read there (`Features.rollover`). Without this rule, some 15 min forex robots "won" 112 R a year by buying this dip.
- **Against lucky streaks**: tuning on the first 70 % of the history, validation on the remaining 30 % never used to choose; at least 60 trades in tuning and 30 in validation; "robustness" = number of neighbouring settings (other stops, other exits) that also pass the criteria, at least 5 %. Ranked by annual return (not extrapolated under one year of history).
- **Since 2020 only**: searches, studies and the report only take candles since 1 January 2020 (the market before did not behave the same); the 70 / 30 % split this period. `--from YYYY-MM-DD` changes the date, `--from all` takes the whole history again. Older history stays for the charts.
- **Money management** compared: fixed 0.3 %, fixed €30, anti-martingale, reduction in drawdown, Kelly ¼, equity curve filter.
- **Open the chart**: a new chart tab on the robot's asset and timeframe (or the tab where it is already open), with the **Robot** indicator (▲×3 / ▼×3 entries, result in R of each signal, current stops and targets). The Robot indicator is also in the indicator list to build one by hand. The indicators the robot reads open with it, set like it: the entry one in bright colors, the filter one in pale lines (for example Stoch Price Envelope 30 for the entry and 100 for the filter). The robot's card lists them ("On the chart"). A tab already open without them gets them at the next click. Filters with no indicator on the platform (Choppiness, Kaufman efficiency, higher-timeframe ZLEMA trend, volatility) add nothing.
- **Stoch Price Envelope on a higher timeframe**: the "Timeframe" setting (1 hour, 4 hours, daily, weekly) computes the envelope on the candles of that timeframe, built from the chart's. Each candle shows the envelope of the last closed higher candle, like the lab (staircase lines).
- **Strategy tester**: it opens on the robot and replays it with the lab's engine on its report's own history (same candles, same period, tuning then validation): list of trades (entry A / B / C, exit reason), statistics, calendar and equity curve, in euros with 0.3 % per entry. A click on an old trade loads the chart's history back to it. The robot is chosen in the tester's menu ("Chart robots") next to the strategies. In the dashboard, hovering a bar of "Gross performance" shows the period (day, week or month), its result, its closed, winning and losing trades, the best and worst trade, and the total since the start.
- **Trading robots tab**: the sorting, market, selection and robot chosen stay when you come back from the chart (and after a reload), the list goes back to the same position.
- **Trade automatically (virtual)**: the robot takes its 3 entries itself on the virtual account live (as long as the platform is open), moves the stops (break-even, trailing) and closes on an opposite signal. No real order is placed.

**Stoch Price Envelope: range or trend.** A separate selection in the tab ("Stoch Price Envelope · range / trend"). In a range, the price goes back and forth between the red (ceiling) and green (floor) lines, flat, and the orange line (signal) stays in the middle: buy low, sell high. In a trend, the envelope climbs like a staircase and the price bounces between the orange and the red line (the green one in a downtrend): the bounds must not be played any more. The regime is read on the robot's timeframe or on a higher one (15 min → 1 h / 4 h, 30 min → 4 h / day, 1 h → 4 h / day, 4 h → day / week, day → week), on the last closed higher candle: a range in 4 h is often a trend in 15 min from one 4 h line to the other. Entries: bounce on the orange line or the middle in the staircase, return from the bottom / top of the channel, staircase resuming, orange line crossing the middle. The "general" search (`general.mjs`) tests each setting on all the markets of a class and timeframe (all forex pairs in 1 h…, at least 3 years of history each) and keeps those that pass the criteria on the most markets at once: the "Settings validated on several markets" table under the report.

**Hour range.** Selection "Hour range · breakout of a one-hour candle": the candle of hour H (Paris time, summer time included) makes a range, the first close above or below before 11 pm gives the day's direction (the TradingView script "XAUUSD 19h - 1H Closed Ref", ported as the "Hour range" indicator). A study (`hour-study.mjs`, map of the selection) measures for each market and each hour whether the price at 11 pm proves the breakout right more often than on any day, over both periods; a click on a cell opens the 15 min chart with this range. The robots (signals `hr_<H>_<length>_<window>_<close>_<mode>`, range stops `rng_opp`, `rng_mid`, `rng_edge`) go through the general search, grid `h1`, "hour-*" rounds.

**Dow structure · price action.** Selection of the same name: the study of the "Market structure (Dow)" indicator.
- **Markets**: 12 forex pairs, 6 indices, gold, silver, oil (WTI, and Brent as a check), BTC and ETH.
- **Candles**: 1 min, 5 min, 15 min, 1 h, 4 h and day (HistData and Binance, since 2020).
- **Ticks**: 150, 250, 500 and 1,000 ticks.
  - Forex, indices and metals: HistData quotes since 2020 (mid price, rollover left out).
  - BTC and ETH: Binance perpetual contract trades since 2023.
  - Binance gold, silver, oil, SPY and QQQ: since their listing.
- **Method**:
  - each setting is measured on the first 70 % (tuning) then on the last 30 % (validation, never used to choose);
  - real costs of each market, round trip, counted in R;
  - the active hours of each market (like Mataf's volatility page) are measured on the tuning period only.
- **Steps** (grids in `dow-study.ts`):
  1. `s1`: the structure (highs, box, entry, exit, costs);
  2. `s2`: the filters (liquidity, active hours, higher timeframe, close strength);
  3. `s3`: the exits (targets, Dow trailing stop, break-even, impulse size);
  4. `r1`: no entry in a range;
  5. `w1`: the "liquidity grab" signal;
  6. `t1`: the ticks;
  7. `q1`: calm hours removed from the market (the structure computed on the active hours only).
- **Walk-forward** (`dow-wf.mjs`): each year since 2023 is traded with the setting that had worked best in the years before. It is done twice: among all the settings tried (`robots/dow/wf`) and among the 144 starting ones (`robots/dow/wf-s1`).
- **Robot kept**: in both walk-forwards, it needs:
  - at least +5 R;
  - 60 % positive years;
  - a class (timeframe included) that wins in total and on half of its markets.

  The setting shown is the one to use today, that is the best over all years.
- **Checks**:
  - test against 200 random entry draws in the direction of the same trend (`dow-luck.mjs`);
  - neighbouring settings and years (`dow-inspect.mjs`);
  - Brent, never seen by the study, to check the conclusion on commodities.
- The selection's card shows:
  - the robots kept, with their years and a button that opens the chart with the indicator already set;
  - the active hours of each market;
  - the best setting of each market;
  - the method's raw edge, with and without costs.

```bash
node robots/.build/dow-ticks.mjs histdata    # HistData ticks -> robots/dow/ticks (binance: Binance perpetuals)
node robots/.build/dow-study.mjs s1 --tf 1m,5m,15m,1h,4h,1d   # one step (s1, s2, s3, r1, w1, t1, q1)
node robots/.build/dow-report.mjs s1 --base robots/dow/s2-base.json   # reading; bases of the next step
node robots/.build/dow-inspect.mjs histdata_XAUUSD_4h "<setting>"   # one setting: year by year, neighbouring settings
node robots/.build/dow-luck.mjs binance_ETHUSDT_4h "<setting>"      # against random entries
node robots/.build/dow-wf.mjs s1,s2,s3,r1,w1 --tf 15m,1h,4h,1d      # walk-forward (--out robots/dow/wf-s1 with s1 alone)
node robots/.build/dow-publish.mjs s1,s2,s3,t1,r1,w1 --wf robots/dow/wf --wf-check robots/dow/wf-s1   # public/robots/dow.json
```

### Night lab (levels, ICT, breakouts)

31 strategy families, on 10 forex pairs, 4 commodities, 7 indices, BTC and ETH, since 2020, real costs included:
- pivot points, liquidity, ICT, ORB, CRT;
- supports and resistances, trend lines;
- volatility breakouts, Donchian, momentum.

Results and report in `robots/night` (`rapport-nuit.html`, `NUIT.md`).

```bash
node robots/.build/night.mjs pivots,liq,sb        # families of your choice (--tf 15m,1h ; --out <suffix>)
node robots/.build/night-inspect.mjs lwvb 15m Crypto "lwvb|0.5|50|eod|long"   # against chance, costs +50 %
node robots/.build/night-portfolio.mjs 0.5 "lwvb:15m:Crypto:lwvb|0.5|50|eod|long" "pivweek:1h:Crypto:pivweek|H4|0|eow|long"
node robots/.build/night-wf.mjs pivweek 1h Crypto 60   # walk-forward, no look-ahead
```

The "Pivot points + breakouts (day / week)" indicator (`src/indicators/custom/pivotPoints.ts`) takes up its three rules that held.

### Opening gaps of the cash indices

```bash
node scripts/robots/gap-fetch.mjs      # IB Gateway open: cash indices 15 min since 2020 (IBKR) + daily (Yahoo), in robots/gaps/data
node scripts/robots/build.mjs
node robots/.build/gap-study.mjs       # robots/gaps/GAPS.txt, gap-stats.json, rapport-gaps.html and src/indicators/custom/gapStats.ts
```

Gap filling by index, direction and size (within 15 min, 30 min, 1 h, 2 h, by the close), median time, extension before filling, and trading rules tested with costs (2020-2023 then 2024 → today). Result: small gaps often fill (73 %), big ones rarely (18 % beyond 1 %), and no "fade the gap" or "go with the gap" rule wins. The "Opening gap" indicator shows these odds of filling.

### Study of the main-list indices

Open search on the 8 indices of the main list (HSI, Nikkei, CAC 40, DAX 40, S&P 500, Nasdaq 100, Dow Jones, Russell 2000):
- about 50 candle patterns;
- with or without the 200 average filter;
- long and short, over several holding times;
- in 15 min, 1 h, 4 h and daily, since 2020, index costs included.

What is found over 2020-01 → 2024-08 is checked over 2024-09 → today. Each rule is compared with "being in the market on the same days". The results are in `robots/index`.

```bash
node robots/.build/index-study.mjs            # the search (--tf 15m,1h,4h,1d) -> study-report.txt
node robots/.build/index-inspect.mjs          # a close look at the daily findings: neighbours, years, chance, 39 other indices, regime
```

The "Calm / choppy regime (indices)" indicator (`src/indicators/custom/indexRegime.ts`) comes from this study.

The lab runs outside the browser, on all the processor's cores:

```bash
node scripts/robots/build.mjs               # builds the lab (reuses the app's indicator code)
node robots/.build/history.mjs              # history: Binance crypto, HistData (forex, metals, indices), Yahoo indices
node scripts/robots/fetch-data.mjs          # Binance Futures (TradFi) and Yahoo -> robots/data
node robots/.build/lab.mjs --plan r1        # wide search; --plan r2: refining the families that work
node robots/.build/lab.mjs --plan s1        # Stoch Price Envelope, range / trend ("night-*" rounds)
node robots/.build/general.mjs               # same settings on all the markets of a class at once
node robots/.build/hour-study.mjs            # hour range: does the candle's hour give the day's direction?
node robots/.build/general.mjs --grid h1 --round hour-h1 --tfs 15m,30m,1h --dump   # hour-range robots
node robots/.build/report.mjs               # public/robots/report.json, read by the tab
```

`relancer-robots.bat` does everything at once with fresh data (to schedule every week if needed).

Full history (`history.mjs`): only downloads what is missing, then builds 5 min, 15 min, 30 min, 1 h, 4 h and day from the minute (`binance_<pair>_<timeframe>.bin`, `histdata_<asset>_<timeframe>.bin`, `yf_<index>_<timeframe>.bin`).

- **Binance**: each crypto of `src/data/symbols.ts` since its listing (monthly archives of data.binance.vision, then daily ones for the current month).
- **HistData.com**: 41 forex pairs (majors since 2000, crosses since 2002 to 2008, exotics since 2008 to 2010); gold and silver since 2009; WTI oil, S&P 500, Nasdaq 100, DAX, CAC 40, FTSE 100 and Nikkei since 2010. HistData does not have USDILS, EURZAR, EURSGD, GBPNOK, GBPSEK, GBPZAR, GBPSGD, NOKJPY, SEKJPY. Time: HistData states a fixed UTC−5, but its candles follow New York summer time (US dates until 2018, European ones since 2019; checked against Binance gold, Yahoo's EURUSD and gold's daily pause, always at 5 pm New York); brought back to UTC with this rule (the import's "HistData" zone). The ZIPs are kept in `robots/raw/histdata`; those already downloaded by hand into "Downloads" are picked up.
- **HistData, indices added later** (Euro Stoxx 50 from 2010 to 2019, Hang Seng, ASX 200 and Dollar Index since 2010): stored light so as not to fill the disk, 15 min and above over the whole history, 1 and 5 min over the last 3 months only; their ZIPs are deleted once read (`<code>.read.json` keeps the list).
- **Yahoo Finance**: each index of the platform (US large, mid and small caps, France, Germany, Euronext, London, Japan, China…) in 15 min over 60 days, 1 h over 2 years and day from the start, added to what previous runs kept: the 15 min history grows longer at each run.
- **Bad ticks**: HistData has some (EURUSD at 1965 for one minute in 2001, AUDUSD opening at 39.8 in 2004, prices at 0.10 or negative, and the whole of May 2005 of AUDJPY filled with other pairs' prices). They are removed at build time (`cleanBars`, `scripts/robots/dataset.ts`): a price far from the surrounding candles (50 times their usual range, or recent range when the market gets agitated) that they do not confirm is brought back to their level or removed; a month where more than 5 % of the candles are wrong is dropped entirely. Real moves (Swiss franc 2011 and 2015, Turkish lira 2021, weekend gaps) last more than one candle and stay. `history.mjs clean` repairs already built files without downloading anything; `histdata --rebuild` rebuilds from the ZIPs.
- `history.mjs retime`: realigns once the HistData files read as UTC−5 all year round (one hour late in summer); `robots/raw/histdata/retimed.txt` keeps the list of markets done.
- Options: `binance`, `histdata` or `yahoo` alone, `clean`, `retime`, `--only EURUSD,DAX40`, `--rebuild`.

No free 15 min source over several years for S&P 400 / 600, MDAX, SDAX, SBF 120, FTSE 250, TOPIX or the mainland Chinese indices: Yahoo stops at 60 days, and Dukascopy (indices and ETFs by the minute) no longer serves scripted downloads (429 response); it points to its official export on Amazon S3 "Requester Pays", which needs an AWS account (a few cents paid by the requester).

`.bin` files: a JSON header (asset, timeframe, number of bars, dates) then the bars, 24 bytes each (prices as integers × 10^decimals, read back exactly; float64 if a price does not fit), `scripts/robots/dataset.ts`. Old `.json` files are still read. Each search takes the last 200,000 bars of a series (`lab.mjs --max-bars N` to change it): years of 1 min would take hours per market.
Past results do not guarantee future results: validate on the virtual account before any real money.

## Developer · Data

A "New tab" tool that lists all the price data (OHLC) of the platform, in two places:

- **Lab (disk)**: the files of `robots/data`, used by the robot search. The development server lists them (`/api/data/lab`) and keeps an index in `robots/.data-index.json`.
- **Browser**: what the charts saved (see "Offline data"), plus the imports.

Views:

- **Inventory**: an asset × timeframe table. Each cell gives the duration covered and the dates ("Mar 23 → today"). Its color says whether the history is enough to test a robot: 1 year in 1 and 5 min, 3 years in 15 and 30 min, 5 years in 1 h and 4 h, 10 years in day. A click on an asset details each series: source, start, end, number of bars, size, and whether the lab has already tested it. You can open the chart, copy a lab series into the browser (offline charts, replay), or delete a browser series or a lab import.
- **Download a history** (blue button, or a click on a table cell, which pre-fills the asset and timeframe): choose the asset, the timeframe (1 min to day), the length (1 month to 10 years, or everything) and the source. The development server downloads into `robots/data/dl_<source>_<asset>_<timeframe>.bin`, where the charts and the lab read it. Bars already there are kept and not requested again: Binance and IBKR only download what is missing, before the file's first bar and after its last. What arrives is saved as it comes. The Dow (DJI) comes from the IBUS30 CFD, aligned session by session on the index's official close. By default, the timeframes above (up to 4 h) are built from the same bars. Progress shows at the top of the tab and in the cell; the download continues if you leave the tab. Sources, the deepest first:
  - **Binance** (crypto): everything since listing, in a few minutes;
  - **Interactive Brokers** (IB Gateway open, read-only requests): cash indices (S&P 500, Nasdaq 100, Russell, DAX, CAC, Nikkei, Hang Seng), the Dow through its CFD (IBKR refuses the index without a subscription), index CFDs, US stocks over several years; futures (US30, US500, US100, US2000, J225, DE40, FR40, HK50): real expiries put end to end, a bit over a year (IBKR keeps no more expired contracts). One IBKR download at a time;
  - **Yahoo**: fast but short (30 days in 1 min, 60 days from 5 to 30 min, 2 years in 1 h and 4 h, everything in day).

  The code: `src/data/downloadPlan.ts` (sources and depths), `scripts/history-download.ts` (server, `/api/data/download`), `src/components/pages/data/Downloads.tsx` (window and progress).
- **What is missing**: the timeframes where the lab lacks history, where to find the data (MetaTrader 5, Dukascopy, HistData, Binance), and what the free sources give live.
- **Import files**: drop CSV, TXT or ZIP files anywhere in the tab. Supported formats:
  - MetaTrader 4 and 5;
  - Dukascopy, HistData, Binance (data.binance.vision);
  - TradingView, Yahoo;
  - any CSV with a date and the open, high, low, close columns (separator `,` `;` or tab, decimal comma accepted).

  Files of the same market (months, years) are joined. The timeframe is read from the data, and the file's time is brought back to UTC. The "MetaTrader broker" choice applies UTC+2, or UTC+3 during US summer time. Destinations:
  - the lab: `robots/data/import_<asset>_<timeframe>.bin`, taken by the next search;
  - the browser: never purged, and the charts' scrolling into the past continues in it.

  Larger timeframes (15 min, 1 h, 4 h, day) are built from the finest one. For non-crypto markets, the Sunday evening session counts in Monday.

## Tabs and "New tab"

Like the TradingView desktop app, a tab bar at the top of the window:

- Each chart tab is a complete layout (symbol, timeframe, indicators, layout, settings); it shows the symbol, its price and its change. A layout opened in a tab is saved automatically when the chart changes.
- ＋ opens the **New tab** page: the layouts ("Superchart") with search, sorting, favorites ☆ and a ⋮ menu (open, open in a new tab, rename, copy, export, delete), and one tile per tool, which opens full page in the tab: Screener, Heatmap, Calendars (economic, earnings, dividends), News flow, Portfolios, Yield curves, Options, Fundamental charts, Markets, Community (published indicators), Macro Maps. The customize button at the bottom right hides the tiles you do not need.
- Right-click a tab: duplicate, close, close the others / to the right, reopen the last closed tab; middle-click to close, drag and drop to reorder; •••: full screen, theme.
- Dragging an asset from a list (right or left) onto the tab bar opens it in a **new chart tab**: right after the tab you drop it on, or at the end elsewhere in the bar. A blue line shows where it will go.
- In a tool page, clicking a symbol opens it on the last chart used.
- A tool page comes back where you left it when you return to its tab: filters, search, view, selection and scrolling (Data, Screener, Heatmap, Calendars, News, Options, Fundamentals, Markets, Community, Yield curves, Macro Maps, Robots). The choices also stay after a reload; the loaded data and the week shown, as long as the app is open (`src/components/kept.ts`).

Portfolios: buy / sell transactions (average cost), live value and P&L, value history from daily prices, allocation. Community: open-source scripts (Pine v4 and v5) can be added to the chart, the Pine editor or the strategy tester.

**Options** (like TradingView): US stocks and ETFs, indices (SPX, NDX) and options on futures (ES1!, NQ1!, GC1!, CL1!…: nearest contract). Tabs:

- Chain: all expiries grouped (DTE, root E4D / EW4 / SPXW…), foldable, calls | strike | puts, ±N strikes around the price, vertical spreads, columns of your choice (delta, gamma, theta, vega, rho, BE, IV, theoretical, bid × ask, distance, open interest, volume); click a bid = sell, an ask = buy.
- Strategy builder: ready-made strategies or legs from the chain, payoff at expiry and on a chosen date (Black-Scholes), max gain / loss, break-evens, greeks.
- Strategy finder: according to the outlook (bullish, bearish, neutral, volatile) and a target price, ranked by reward / risk, gain at the target price or probability of profit.
- Volatility (smile, term structure) and Volume (volume and open interest by strike, put/call ratios, max pain).

Volume and open interest: Yahoo Finance via `/api/yoptions` (US options only).

**Heatmap**: S&P 500, Nasdaq 100, Dow Jones, Russell 2000, CAC 40, DAX, FTSE 100, Euro Stoxx 50, IBEX, SMI, Nikkei, whole markets or cryptos; size (market cap, value traded, employees), color (change from 1D to 1Y, pre-market, gap), grouping by sector / industry with zoom on a group.

**Calendar**: week with the number of events per day, Economy / Earnings / Dividends / IPO tabs, time zone, country, importance and categories; countdown to the next releases. The economic calendar comes from the free ForexFactory feed (current week, without the actual value).

**Macro Maps**: all indicators are shown as buttons when the width allows (the others go into "•••"), map and country ranking side by side, full page.

## Quick drawing bar

★ in the left toolbar shows the floating bar; its ＋ button adds or removes tools and templates.

## License

The code is under the [MIT License](LICENSE): free to use, change and share, with no warranty.

- Charts are drawn with TradingView Lightweight Charts™ (Apache License 2.0), © TradingView, Inc.
- The company and crypto logos in `public/logos` belong to their owners. `scripts/fetch-logos.ts` downloads them again.
- Market data stays the property of its providers (Binance, Yahoo Finance, TradingView, Interactive Brokers…), under their own terms.
