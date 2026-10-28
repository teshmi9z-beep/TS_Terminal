import { useState } from 'react';
import type { AssetCategory, Symbol } from '../types';
import { LOGO_FILES } from '../data/logoFiles';
import { logoFileName } from '../data/logoName';

type Badge = { bg: string; glyph: string; textColor?: string };

const CATEGORY_BADGE: Record<AssetCategory, Badge> = {
  Crypto: { bg: '#f7931a', glyph: '₿' },
  Forex: { bg: '#2962ff', glyph: '$' },
  Actions: { bg: '#7e57c2', glyph: 'A' },
  Indices: { bg: '#00897b', glyph: '#' },
  'Matieres premieres': { bg: '#b8860b', glyph: '◆' },
};

// per-ticker overrides so common assets get their own recognisable icon,
// like TradingView's coin/commodity logos, instead of one generic category badge
const TICKER_BADGE: Record<string, Badge> = {
  BTCUSD: { bg: '#f7931a', glyph: '₿' },
  ETHUSD: { bg: '#627eea', glyph: 'Ξ' },
  SOLUSD: { bg: '#14f195', glyph: '◎', textColor: '#0e1117' },
  XRPUSD: { bg: '#23292f', glyph: '✕' },
  // the CoinShares ETPs wear their coin's badge
  BITC: { bg: '#f7931a', glyph: '₿' },
  CETH: { bg: '#627eea', glyph: 'Ξ' },
  SLNC: { bg: '#14f195', glyph: '◎', textColor: '#0e1117' },
  XRPL: { bg: '#23292f', glyph: '✕' },
  BNBUSD: { bg: '#f3ba2f', glyph: 'B', textColor: '#0e1117' },
  DOGEUSD: { bg: '#c2a633', glyph: 'Ð' },
  ADAUSD: { bg: '#0033ad', glyph: '₳' },
  TRXUSD: { bg: '#eb0029', glyph: 'T' },
  LTCUSD: { bg: '#345d9d', glyph: 'Ł' },
  BCHUSD: { bg: '#8dc351', glyph: '₿' },
  XMRUSD: { bg: '#ff6600', glyph: 'ɱ' },
  ZECUSD: { bg: '#f4b728', glyph: 'ⓩ', textColor: '#0e1117' },
  DOTUSD: { bg: '#e6007a', glyph: '●' },
  LINKUSD: { bg: '#2a5ada', glyph: '⬡' },
  AVAXUSD: { bg: '#e84142', glyph: 'A' },
  XAUUSD: { bg: '#d4af37', glyph: 'Au', textColor: '#0e1117' },
  XAGUSD: { bg: '#c0c0c0', glyph: 'Ag', textColor: '#0e1117' },
  WTI: { bg: '#1c1c1c', glyph: '🛢' },
  NATGAS: { bg: '#1c1c1c', glyph: '🔥' },
  COPPER: { bg: '#b87333', glyph: 'Cu', textColor: '#0e1117' },
  CORN: { bg: '#f4c542', glyph: '🌽', textColor: '#0e1117' },
  SPX500: { bg: '#d32f2f', glyph: '500' },
  NDX100: { bg: '#1a237e', glyph: '100' },
  DJI: { bg: '#1565c0', glyph: '30' },
  DAX40: { bg: '#212121', glyph: '40' },
  CAC40: { bg: '#2e7d32', glyph: '40' },
  FTSE100: { bg: '#7b1fa2', glyph: '100' },
  NIKKEI: { bg: '#c62828', glyph: '225' },
  RUT2000: { bg: '#00838f', glyph: '2K' },
  US500: { bg: '#d32f2f', glyph: '500' },
  US100: { bg: '#1a237e', glyph: '100' },
  US30: { bg: '#1565c0', glyph: '30' },
  J225: { bg: '#c62828', glyph: '225' },
  US2000: { bg: '#00838f', glyph: '2K' },
  IBUS500: { bg: '#d32f2f', glyph: '500' },
  IBUST100: { bg: '#1a237e', glyph: '100' },
  IBUS30: { bg: '#1565c0', glyph: '30' },
  IBDE40: { bg: '#212121', glyph: '40' },
  IBFR40: { bg: '#2e7d32', glyph: '40' },
  IBJP225: { bg: '#c62828', glyph: '225' },
  DE40: { bg: '#212121', glyph: '40' },
  FR40: { bg: '#2e7d32', glyph: '40' },
};

// ISO country codes for flagcdn.com — Windows/Chrome doesn't render flag emoji
// glyphs (falls back to plain letters), so we use small flag images instead.
const CURRENCY_COUNTRY: Record<string, string> = {
  USD: 'us', EUR: 'eu', GBP: 'gb', JPY: 'jp', CHF: 'ch', AUD: 'au', CAD: 'ca', NZD: 'nz',
  TRY: 'tr', ZAR: 'za', MXN: 'mx', SEK: 'se', NOK: 'no', DKK: 'dk', PLN: 'pl', THB: 'th',
  CNY: 'cn', HKD: 'hk', SGD: 'sg', INR: 'in', BRL: 'br', HUF: 'hu', CZK: 'cz', ILS: 'il',
};

// the country (or zone) of each index without its own icon, shown as its flag
const INDEX_COUNTRY: Record<string, string> = {
  SP400: 'us', SP600: 'us', SP100: 'us', NASDAQ: 'us', NYSE: 'us', RUT1000: 'us', RUT3000: 'us', DJTRANS: 'us', VIX: 'us', DXY: 'us',
  SBF120: 'fr', CACMID60: 'fr', CACNEXT20: 'fr', MDAX: 'de', SDAX: 'de', TECDAX: 'de',
  EURONEXT100: 'eu', NEXT150: 'eu', STOXX50: 'eu', STOXX600: 'eu', AEX: 'nl', AMXNL: 'nl', BEL20: 'be', PSI20: 'pt', ISEQ: 'ie', OBX: 'no',
  IBEX35: 'es', FTSEMIB: 'it', SMI20: 'ch',
  FTSE250: 'gb', FTSE350: 'gb', FTSEALL: 'gb', FTSESMALL: 'gb', FTSEAIM: 'gb',
  NIKKEI300: 'jp', TOPIX: 'jp', TSEGROWTH: 'jp',
  SHCOMP: 'cn', SZCOMP: 'cn', CSI300: 'cn', CSI500: 'cn', CSI1000: 'cn', SSE50: 'cn', STAR50: 'cn', CHINEXT: 'cn', CHINAA50: 'cn',
  HSI: 'hk', HSCEI: 'hk', HSTECH: 'hk', IBHK50: 'hk', HK50: 'hk', ASX200: 'au',
};

function forexFlags(ticker: string): [string, string] | null {
  if (ticker.length !== 6) return null;
  const base = CURRENCY_COUNTRY[ticker.slice(0, 3)];
  const quote = CURRENCY_COUNTRY[ticker.slice(3, 6)];
  return base && quote ? [base, quote] : null;
}

function hashHue(ticker: string): number {
  let h = 0;
  for (let i = 0; i < ticker.length; i++) h = (Math.imul(h, 31) + ticker.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}

// anything without a hand-picked icon gets a per-ticker colour + initials so
// every row still looks distinct, for any symbol added from the search
function autoBadge(ticker: string): Badge {
  const clean = ticker.replace(/^\^/, '').replace(/\.[A-Z]+$/, '');
  return { bg: `hsl(${hashHue(ticker)}, 55%, 42%)`, glyph: clean.slice(0, 2).toUpperCase(), textColor: '#fff' };
}

function badgeFor(s: Pick<Symbol, 'ticker' | 'category'>): Badge {
  if (TICKER_BADGE[s.ticker]) return TICKER_BADGE[s.ticker];
  if (s.category === 'Actions' || s.category === 'Crypto') return autoBadge(s.ticker);
  return CATEGORY_BADGE[s.category] ?? autoBadge(s.ticker);
}

// real company / coin logos, like TradingView: the copies in public/logos first
// (scripts/fetch-logos.ts), then the same sites online for symbols added from the search;
// the coloured badge stays the last resort
const LOCAL_LOGOS = new Set(LOGO_FILES);
const failedLogos = new Set<string>();
// the CoinShares ETPs wear their coin's logo
const ETP_COIN: Record<string, string> = { BITC: 'BTC', CETH: 'ETH', SLNC: 'SOL', XRPL: 'XRP' };

type LogoSym = Pick<Symbol, 'ticker' | 'category'> & Partial<Pick<Symbol, 'yahoo'>>;

function logoUrls(sym: LogoSym): { urls: string[]; coin: boolean } {
  const coinOf = ETP_COIN[sym.ticker] ?? (sym.category === 'Crypto' ? sym.ticker.replace(/(USDT|USDC|USD)$/, '') : null);
  if (coinOf) {
    const c = coinOf.toLowerCase();
    return {
      coin: true,
      urls: LOCAL_LOGOS.has(`crypto/${coinOf}`) ? [`/logos/crypto/${logoFileName(coinOf)}.png`] : [
        `https://assets.coincap.io/assets/icons/${c}@2x.png`,
        `https://cdn.jsdelivr.net/gh/spothq/cryptocurrency-icons@master/32/color/${c}.png`,
      ],
    };
  }
  if (sym.category !== 'Actions') return { urls: [], coin: false };
  const y = sym.yahoo ?? sym.ticker;
  return {
    coin: false,
    urls: LOCAL_LOGOS.has(`stocks/${y}`) ? [`/logos/stocks/${encodeURIComponent(logoFileName(y))}.png`] : [
      `https://assets.parqet.com/logos/symbol/${encodeURIComponent(y)}?format=png&size=64`,
      `https://financialmodelingprep.com/image-stock/${encodeURIComponent(y)}.png`,
    ],
  };
}

export function SymbolLogo({ sym, size = 20 }: { sym: LogoSym; size?: number }) {
  // re-render once a logo fails to load, to try the next source
  const [, setFailures] = useState(0);
  const flags = sym.category === 'Forex' ? forexFlags(sym.ticker) : null;
  if (flags) {
    return (
      <span className="wl-flag-pair" style={{ width: size + 2, height: size }}>
        <img className="wl-flag wl-flag-1" src={`https://flagcdn.com/24x18/${flags[0]}.png`} alt="" />
        <img className="wl-flag wl-flag-2" src={`https://flagcdn.com/24x18/${flags[1]}.png`} alt="" />
      </span>
    );
  }
  const country = sym.category === 'Indices' ? INDEX_COUNTRY[sym.ticker] : undefined;
  if (country) {
    return (
      <span className="wl-flag-pair" style={{ width: size, height: size }}>
        <img className="wl-flag wl-flag-solo" src={`https://flagcdn.com/24x18/${country}.png`} alt="" />
      </span>
    );
  }
  const logo = logoUrls(sym);
  const url = logo.urls.find((u) => !failedLogos.has(u));
  if (url) {
    return (
      <img
        className={`wl-logo wl-logo-img ${logo.coin ? 'coin' : ''}`} src={url} alt="" loading="lazy" draggable={false}
        style={{ width: size, height: size }}
        onError={() => { failedLogos.add(url); setFailures((n) => n + 1); }}
      />
    );
  }
  const badge = badgeFor(sym);
  return (
    <span className="wl-logo" style={{ background: badge.bg, color: badge.textColor, width: size, height: size }}>
      {badge.glyph}
    </span>
  );
}
