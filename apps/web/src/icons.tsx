import type { CSSProperties } from 'react';

export type IconName = 'activity' | 'arrow' | 'check' | 'chevron' | 'cloud' | 'code' | 'copy' | 'database' | 'download' | 'error' | 'external' | 'file' | 'git' | 'help' | 'layers' | 'lock' | 'moon' | 'pause' | 'play' | 'refresh' | 'search' | 'server' | 'settings' | 'shield' | 'spark' | 'sun' | 'terminal' | 'time' | 'upload' | 'x';
const paths: Record<IconName, React.ReactNode> = {
  activity: <path d="M3 12h4l3-8 4 16 3-8h4" />,
  arrow: <><path d="M4 12h16m-6-6 6 6-6 6" /></>,
  check: <path d="m5 12 4 4L19 6" />,
  chevron: <path d="m9 5 7 7-7 7" />,
  cloud: <path d="M6 18a4 4 0 0 1-1-7.9 6 6 0 0 1 11.8-1.6A4.8 4.8 0 0 1 18 18H6Z" />,
  code: <><path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-14-2 18" /></>,
  copy: <><rect x="8" y="8" width="12" height="13" rx="2" /><path d="M15 8V3H3v13h5" /></>,
  database: <><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0" /></>,
  download: <><path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5" /></>,
  error: <><circle cx="12" cy="12" r="9" /><path d="M12 7v6m0 4h.01" /></>,
  external: <><path d="M14 3h7v7m0-7L10 14M10 3H3v18h18v-7" /></>,
  file: <><path d="M14 3H5v18h14V8l-5-5Zm0 0v5h5M8 12h8m-8 4h6" /></>,
  git: <><circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="6" r="2" /><path d="M6 7v10m12-9c0 5-12 2-12 8" /></>,
  help: <><circle cx="12" cy="12" r="9" /><path d="M9 8a3 3 0 0 1 6 1c0 2-3 2-3 4m0 4h.01" /></>,
  layers: <><path d="m12 3 10 6-10 6L2 9l10-6Zm-9 11 9 5 9-5M3 18l9 5 9-5" /></>,
  lock: <><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 4v3" /></>,
  moon: <path d="M20.3 14.2A8.5 8.5 0 0 1 9.8 3.7a8.5 8.5 0 1 0 10.5 10.5Z" />,
  pause: <><path d="M8 5v14m8-14v14" /></>,
  play: <path d="m8 4 12 8-12 8V4Z" />,
  refresh: <><path d="M20 7a9 9 0 0 0-15-2L2 8m0-5v5h5m-3 9a9 9 0 0 0 15 2l3-3m0 5v-5h-5" /></>,
  search: <><circle cx="10" cy="10" r="7" /><path d="m15 15 6 6" /></>,
  server: <><rect x="3" y="3" width="18" height="7" rx="2" /><rect x="3" y="14" width="18" height="7" rx="2" /><path d="M7 6.5h.01M7 17.5h.01M12 6.5h5M12 17.5h5" /></>,
  settings: <><path d="M4 6h16M4 12h16M4 18h16" /><circle cx="9" cy="6" r="2" fill="var(--sidebar-bg)" /><circle cx="15" cy="12" r="2" fill="var(--sidebar-bg)" /><circle cx="8" cy="18" r="2" fill="var(--sidebar-bg)" /></>,
  shield: <><path d="m12 2 9 4v6c0 6-9 10-9 10S3 18 3 12V6l9-4Z" /><path d="m8 12 3 3 5-6" /></>,
  spark: <><path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z" /></>,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" /></>,
  terminal: <><rect x="2" y="4" width="20" height="16" rx="2" /><path d="m6 8 4 4-4 4m7 0h5" /></>,
  time: <><circle cx="12" cy="12" r="9" /><path d="M12 6v6l4 2" /></>,
  upload: <><path d="M12 16V4m-5 5 5-5 5 5M4 16v5h16v-5" /></>,
  x: <path d="m6 6 12 12M6 18 18 6" />,
};

export function Icon({ name, size = 18, style }: { name: IconName; size?: number; style?: CSSProperties }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" style={style}>{paths[name]}</svg>;
}

export function BrandMark() {
  return <svg width="31" height="31" viewBox="0 0 32 32" fill="none" aria-hidden="true" focusable="false"><path d="M4 5h6c4 0 4 7 8 7h10M4 16h24M4 27h6c4 0 4-7 8-7h10" stroke="currentColor" strokeWidth="3" strokeLinecap="round"/><circle cx="25" cy="16" r="3" fill="currentColor"/></svg>;
}
