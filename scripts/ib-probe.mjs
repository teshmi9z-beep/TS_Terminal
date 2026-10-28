// Probe of the Interactive Brokers gateway: which index CFDs and futures resolve, and whether
// historical bars come back (read-only: contract details and historical data requests only).
import { IBApi, EventName, SecType, BarSizeSetting, WhatToShow } from '@stoqey/ib';

const port = Number(process.argv[2] ?? 4001);
const ib = new IBApi({ host: '127.0.0.1', port, clientId: 71 });
const C = (symbol, secType, exchange, currency) => ({ symbol, secType, exchange, currency });
const probes = [
  C('IBUS30', SecType.CFD, 'SMART', 'USD'), C('IBUS500', SecType.CFD, 'SMART', 'USD'), C('IBUST100', SecType.CFD, 'SMART', 'USD'),
  C('IBDE40', SecType.CFD, 'SMART', 'EUR'), C('IBFR40', SecType.CFD, 'SMART', 'EUR'), C('IBJP225', SecType.CFD, 'SMART', 'JPY'),
  C('IBHK50', SecType.CFD, 'SMART', 'HKD'), C('IBUS2000', SecType.CFD, 'SMART', 'USD'),
  C('ES', SecType.CONTFUT, 'CME', 'USD'), C('YM', SecType.CONTFUT, 'CBOT', 'USD'), C('DAX', SecType.CONTFUT, 'EUREX', 'EUR'),
  C('CAC40', SecType.CONTFUT, 'MONEP', 'EUR'), C('HSI', SecType.CONTFUT, 'HKFE', 'HKD'), C('N225M', SecType.CONTFUT, 'OSE.JPN', 'JPY'),
  C('SPX', SecType.IND, 'CBOE', 'USD'), C('DAX', SecType.IND, 'EUREX', 'EUR'),
];
let id = 100;
const pending = new Map();
const wait = (reqId, kind) => new Promise((res) => pending.set(reqId, { kind, res, rows: [], err: null }));
ib.on(EventName.error, (err, code, reqId) => {
  const p = pending.get(reqId);
  if (p) { p.err = `${code} ${err?.message ?? err}`; pending.delete(reqId); p.res(p); }
  else if (![2104, 2106, 2158, 2107, 2108, 2119].includes(code)) console.log('info', code, err?.message ?? err);
});
ib.on(EventName.contractDetails, (reqId, d) => pending.get(reqId)?.rows.push(d));
ib.on(EventName.contractDetailsEnd, (reqId) => { const p = pending.get(reqId); if (p) { pending.delete(reqId); p.res(p); } });
ib.on(EventName.historicalData, (reqId, time, o, h, l, c, v) => {
  const p = pending.get(reqId);
  if (!p) return;
  if (String(time).startsWith('finished')) { pending.delete(reqId); p.res(p); } else p.rows.push([time, o, h, l, c, v]);
});
const timeout = (ms) => new Promise((r) => setTimeout(() => r({ err: 'timeout', rows: [] }), ms));

ib.once(EventName.nextValidId, async () => {
  console.log('server version', ib.serverVersion);
  for (const c of probes) {
    const r1 = id++;
    ib.reqContractDetails(r1, c);
    const d = await Promise.race([wait(r1, 'cd'), timeout(15000)]);
    if (!d.rows.length) { console.log(`${c.symbol} ${c.secType}: no contract (${d.err})`); continue; }
    const cd = d.rows[0], k = cd.contract;
    const what = c.secType === SecType.CFD || c.secType === SecType.IND ? (c.secType === SecType.IND ? WhatToShow.TRADES : WhatToShow.MIDPOINT) : WhatToShow.TRADES;
    const r2 = id++;
    // a continuous future is asked as such (without the resolved month)
    const hc = c.secType === SecType.CONTFUT ? c : { conId: k.conId, exchange: k.exchange || c.exchange };
    ib.reqHistoricalData(r2, hc, '', '2 D', BarSizeSetting.MINUTES_FIFTEEN, what, 0, 2, false);
    const h = await Promise.race([wait(r2, 'h'), timeout(30000)]);
    const bars = h.rows;
    const first = bars[0], last = bars[bars.length - 1];
    const fmt = (b) => (b ? `${new Date(Number(b[0]) * 1000).toISOString().slice(5, 16)} O${b[1]} H${b[2]} L${b[3]} C${b[4]}` : '-');
    console.log(`${c.symbol} ${c.secType} conId ${k.conId} ${cd.longName ?? ''} [${cd.tradingHours?.slice(0, 40) ?? ''}] → ${bars.length} bars ${h.err ?? ''} | ${fmt(first)} … ${fmt(last)}`);
  }
  ib.disconnect();
  process.exit(0);
});
ib.connect();
setTimeout(() => { console.log('global timeout'); process.exit(1); }, 300000);
