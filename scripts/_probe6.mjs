// Cash indices on IBKR (earliest intraday bar) and the futures' contract lists with expired ones.
import { IBApi, EventName, SecType, WhatToShow } from '@stoqey/ib';
const ib = new IBApi({ host: '127.0.0.1', port: 4001, clientId: 77 });
const pending = new Map();
let id = 10;
const wait = (fn, ms = 30000) => new Promise((res) => { const r = id++; const p = { rows: [], res }; pending.set(r, p); fn(r); setTimeout(() => res({ rows: p.rows, err: 'timeout' }), ms); });
ib.on(EventName.error, (e, code, r) => { const p = pending.get(r); if (p && !(code >= 2100 && code < 2200)) { p.err = `${code} ${String(e?.message ?? e).slice(0, 80)}`; p.res(p); } });
ib.on(EventName.headTimestamp, (r, t) => { const p = pending.get(r); if (p) { p.rows.push(t); p.res(p); } });
ib.on(EventName.contractDetails, (r, d) => pending.get(r)?.rows.push(d));
ib.on(EventName.contractDetailsEnd, (r) => { const p = pending.get(r); if (p) p.res(p); });
const iso = (t) => /^\d+$/.test(t) ? new Date(Number(t) * 1000).toISOString().slice(0, 10) : t;
ib.once(EventName.nextValidId, async () => {
  for (const [s, ex, cur] of [['SPX', 'CBOE', 'USD'], ['NDX', 'NASDAQ', 'USD'], ['INDU', 'CME', 'USD'], ['RUT', 'RUSSELL', 'USD'], ['DAX', 'EUREX', 'EUR'], ['CAC40', 'MONEP', 'EUR'], ['N225', 'OSE.JPN', 'JPY'], ['HSI', 'HKFE', 'HKD']]) {
    const h = await wait((r) => ib.reqHeadTimestamp(r, { symbol: s, secType: SecType.IND, exchange: ex, currency: cur }, WhatToShow.TRADES, true, 2));
    console.log(`IND ${s.padEnd(6)} earliest ${h.rows[0] ? iso(h.rows[0]) : '-'} ${h.err ?? ''}`);
  }
  for (const [s, ex, cur] of [['DAX', 'EUREX', 'EUR'], ['CAC40', 'MONEP', 'EUR'], ['HSI', 'HKFE', 'HKD']]) {
    const d = await wait((r) => ib.reqContractDetails(r, { symbol: s, secType: SecType.FUT, exchange: ex, currency: cur, includeExpired: true }));
    const list = d.rows.map((x) => `${x.contract.tradingClass}/${x.contract.multiplier}/${x.contract.lastTradeDateOrContractMonth}`).sort();
    console.log(`FUT ${s}: ${list.length} contracts ${d.err ?? ''}`, list.filter((x) => !/FDXS|FDXM|MHI|MCH/.test(x)).slice(0, 40).join(' '));
  }
  ib.disconnect(); process.exit(0);
});
ib.connect();
