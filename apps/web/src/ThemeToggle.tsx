import { useEffect, useState } from 'react';
import { Icon } from './icons';
import { applyTheme, readTheme, saveTheme } from './theme';

export function ThemeToggle() {
  const [theme, setTheme] = useState(readTheme);
  useEffect(() => { applyTheme(theme); }, [theme]);
  const next = theme === 'dark' ? 'light' : 'dark';
  const label = `Use ${next} mode`;
  return <button className="theme-toggle" type="button" aria-label={label} title={label} onClick={() => {
    applyTheme(next);
    saveTheme(next);
    setTheme(next);
  }}><Icon name={next === 'light' ? 'sun' : 'moon'} size={17} /><span>{next === 'light' ? 'Light mode' : 'Dark mode'}</span></button>;
}
