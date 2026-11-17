// Icons of the drawings' floating toolbar, drawn like TradingView's (18 px, stroke icons)

const Svg = ({ children }: { children: React.ReactNode }) => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">{children}</svg>
);

// templates: four squares, one with a plus
export const TemplatesIcon = () => (
  <Svg><rect x="2.5" y="2.5" width="5" height="5" rx="1" /><rect x="10.5" y="2.5" width="5" height="5" rx="1" /><rect x="2.5" y="10.5" width="5" height="5" rx="1" /><path d="M13 10.5v5M10.5 13h5" /></Svg>
);
export const PencilIcon = () => (
  <Svg><path d="M11.5 3.5l3 3-8 8H3.5v-3z" /><path d="M10 5l3 3" /></Svg>
);
export const BucketIcon = () => (
  <Svg><path d="M3.5 8.5l5-5 5 5-5 5z" /><path d="M8.5 3.5L7 2" /><path d="M14.5 11.5c0 1 .7 1.8 1 1.8s1-.8 1-1.8-1-2.3-1-2.3-1 1.3-1 2.3z" /></Svg>
);
export const TextIcon = () => (
  <Svg><path d="M4 4h10M9 4v10M7 14h4" /></Svg>
);
export const SettingsIcon = () => (
  <Svg><path d="M9 1.8l6.2 3.6v7.2L9 16.2l-6.2-3.6V5.4z" /><circle cx="9" cy="9" r="2.4" /></Svg>
);
export const AlertIcon = () => (
  <Svg><circle cx="8.5" cy="10" r="5.3" /><path d="M8.5 7.3V10l1.8 1.3M3.3 3.6l1.8-1.4M12 2.2l1.6 1.2" /><path d="M14.5 13.5v3M13 15h3" /></Svg>
);
export const LockIcon = ({ locked }: { locked: boolean }) => (
  <Svg><rect x="4" y="8" width="10" height="7.5" rx="1.5" /><path d={locked ? 'M6 8V5.5a3 3 0 016 0V8' : 'M6 8V5.5a3 3 0 015.8-1'} /></Svg>
);
export const TrashIcon = () => (
  <Svg><path d="M3 5h12M7 5V3.5h4V5M5 5l.7 10h6.6L13 5M7.5 8v4.5M10.5 8v4.5" /></Svg>
);
export const MoreIcon = () => (
  <Svg><circle cx="4" cy="9" r="1" fill="currentColor" /><circle cx="9" cy="9" r="1" fill="currentColor" /><circle cx="14" cy="9" r="1" fill="currentColor" /></Svg>
);
