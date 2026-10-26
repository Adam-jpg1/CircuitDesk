// The header the three front pages share: Projects, Templates, Community.
//
// One component so the three read as one place with three rooms rather than
// three apps, and so a page cannot forget the way back to the others.

import type { ReactNode } from 'react';
import { navigate } from '../ui/primitives';
import { LogoIcon, LayersIcon, UsersIcon, ChipIcon } from '../ui/icons';
import { APP_VERSION_LABEL } from '../version';

export type SiteTab = 'projects' | 'templates' | 'community';

const TABS: { id: SiteTab; label: string; href: string; icon: ReactNode }[] = [
  { id: 'projects', label: 'Projects', href: '#/', icon: <ChipIcon /> },
  { id: 'templates', label: 'Templates', href: '#/templates', icon: <LayersIcon /> },
  { id: 'community', label: 'Community', href: '#/community', icon: <UsersIcon /> },
];

export function SiteHeader({ active, actions }: { active: SiteTab; actions?: ReactNode }) {
  return (
    <header className="dash-header site-header">
      <span className="dash-brand" onClick={() => navigate('#/')} style={{ cursor: 'pointer' }}>
        <LogoIcon /> CircuitDesk
        <span className="badge compile" title="First public beta release">{APP_VERSION_LABEL}</span>
      </span>
      <nav className="site-tabs" aria-label="Sections">
        {TABS.map((t) => (
          <a
            key={t.id}
            href={t.href}
            className={`site-tab${t.id === active ? ' active' : ''}`}
            aria-current={t.id === active ? 'page' : undefined}
          >
            {t.icon}
            {t.label}
          </a>
        ))}
      </nav>
      <div style={{ flex: 1 }} />
      {actions}
    </header>
  );
}
