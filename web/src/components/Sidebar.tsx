import { memo, useCallback, useEffect, useState } from 'react';
import { useConfigUI, useVersion } from '../configStore';
import type { Bot, LiveState, Task } from '@shared/types';
import { BotAvatarFor } from '../avatar/BotAvatar';
import { botVars } from '../lib/colors';
import { configApi } from '../lib/configApi';
import { activityStatus } from '../lib/phrases';
import { useStore } from '../store';
import { api } from '../lib/api';
import { voiceApi } from '../voice/api';
import { useLocalConversation } from '../voice/localConversationStore';
import { Icon } from './Icon';
import { Glyph } from './config/glyphs';
import { Menu } from './Menu';

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() || '?';
}

export function TrafficLights() {
  return (
    <div className="traffic-lights" aria-hidden>
      <span style={{ background: '#FF5F57' }} />
      <span style={{ background: '#FEBC2E' }} />
      <span style={{ background: '#28C840' }} />
    </div>
  );
}

/** Details-panel tabs the sidebar can ask for. The panel listens for `hq:details-tab` on window. */
export type DetailsTab = 'activity' | 'routines' | 'channels' | 'engine' | 'library';

export function openDetailsTab(tab: DetailsTab) {
  const st = useStore.getState();
  useConfigUI.getState().setView('chat');
  if (!st.selectedBotId) { const first = st.bots[0]; if (first) st.selectBot(first.id); }
  st.set({ detailsOpen: true });
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('hq:details-tab', { detail: tab }));
}

/** The roster's sub line: dot tone + text, as in the mockup's `.bot-sub`. */
export type RosterStatus = { tone: 'busy' | 'warn' | 'idle'; text: string };

function voiceMode(status: string): string {
  if (status === 'speaking' || status === 'synthesizing') return 'Speaking';
  if (status === 'transcribing' || status === 'sending' || status === 'waiting') return 'Thinking';
  return 'Listening';
}

/**
 * What to say under a bot's name. Running + asking another bot → "Asking Researcher"; running → the activity
 * phrase; stopped for the person → "Waiting on you"; else "Idle". A live voice conversation counts as busy.
 */
export function rosterStatus(live: LiveState | undefined, voiceStatus: string | null): RosterStatus {
  if (voiceStatus) return { tone: 'busy', text: voiceMode(voiceStatus) };
  if (live?.isRunning) {
    const a = live.activity;
    if (a?.kind === 'messaging_named' && a.detail) return { tone: 'busy', text: `Asking ${a.detail}` };
    return { tone: 'busy', text: activityStatus(live, []) };
  }
  if (live?.awaiting) return { tone: 'warn', text: 'Waiting on you' };
  return { tone: 'idle', text: 'Idle' };
}

/** The bot's role: its label ("Chief of Staff"), else the first clause of its description. */
export function roleFor(bot: Bot): string {
  if (bot.label) return bot.label;
  const d = (bot.description || '').split(/[.\n]/)[0].trim();
  return d.length > 0 && d.length <= 40 ? d : '';
}

const BotRow = memo(function BotRow({ bot, selected, live, voiceStatus, collapsed, onSelect }: {
  bot: Bot; selected: boolean; live: LiveState | undefined; voiceStatus: string | null; collapsed: boolean; onSelect: (id: string) => void;
}) {
  const status = rosterStatus(live, voiceStatus);
  const sub = bot.model ? `${status.text} · ${bot.model}` : status.text;
  const role = roleFor(bot);
  const title = `${bot.name}${role ? ` · ${role}` : ''} · ${sub}`;
  const dot = <i className={`bot-row__dot is-${status.tone}`} aria-label={status.text} />;
  return (
    <button type="button" className={`bot-row${selected ? ' is-selected' : ''}${collapsed ? ' is-rail' : ''}`} style={botVars(bot.avatarColor)} onClick={() => onSelect(bot.id)} aria-current={selected || undefined} title={title}>
      <span className="bot-row__avatar">
        <BotAvatarFor bot={bot} size={30} />
        {collapsed && status.tone !== 'idle' && <span className="bot-row__corner">{dot}</span>}
      </span>
      {!collapsed && (
        <>
          <span className="bot-row__text">
            <span className="bot-row__name">{bot.name}</span>
            <span className="bot-row__sub">{dot}<span className="bot-row__sub-text">{sub}</span></span>
          </span>
          {bot.unread > 0 && <span className="bot-row__meta" aria-label={`${bot.unread} unread`}>{bot.unread}</span>}
        </>
      )}
    </button>
  );
});

/** Footer facts: how many Hermes homes run here, local speech, and whether Telegram is wired up. */
function SidebarFacts({ homes, primaryName }: { homes: number; primaryName: string }) {
  const [telegram, setTelegram] = useState<boolean | null>(null);
  const [localSpeech, setLocalSpeech] = useState(false);
  useEffect(() => {
    let alive = true;
    api.channels().then((c) => { if (alive) setTelegram(!!(c.telegram.configured && c.telegram.chatAllowlisted)); }).catch(() => {});
    voiceApi.options().then((o) => { if (alive) setLocalSpeech(o.provider === 'local' && !!o.capabilities?.tts); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  return (
    <div className="sidebar__facts" aria-label="Status">
      <span>Engine <b>{homes} {homes === 1 ? 'home' : 'homes'} · Mac host</b></span>
      {localSpeech && <span>Speech <b>phonon / {primaryName} · local</b></span>}
      <span>Channels <b>{telegram === null ? 'Web' : `Telegram · ${telegram ? 'on' : 'off'}`}</b></span>
    </div>
  );
}

/** Open tasks across every bot, for the Tasks nav badge. */
function useOpenTaskCount(): number {
  const v = useVersion('tasks');
  const [n, setN] = useState(0);
  useEffect(() => {
    let alive = true;
    configApi.tasks().then((r: { tasks: Task[] }) => { if (alive) setN(r.tasks.filter((t) => t.state !== 'done').length); }).catch(() => {});
    return () => { alive = false; };
  }, [v]);
  return n;
}

function NavItem({ id, label, badge, active, collapsed, onClick, children }: { id: string; label: string; badge?: string | null; active?: boolean; collapsed: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" className={`nav-item${active ? ' is-active' : ''}`} data-nav={id} onClick={onClick} title={label} aria-current={active || undefined}>
      <span className="nav-item__icon">{children}</span>
      {!collapsed && <span className="nav-item__label">{label}</span>}
      {!collapsed && badge && <span className="nav-item__badge">{badge}</span>}
    </button>
  );
}

const STROKE = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

export function Sidebar() {
  const bots = useStore((s) => s.bots);
  const live = useStore((s) => s.live);
  const routines = useStore((s) => s.routines);
  const storeSelectedBotId = useStore((s) => s.selectedBotId);
  const inTasks = useConfigUI((s) => s.view === 'tasks');
  const selectedBotId = inTasks ? null : storeSelectedBotId; // nothing highlighted while the Tasks view is open
  const user = useStore((s) => s.user);
  const collapsed = useStore((s) => s.sidebarCollapsed);
  const set = useStore((s) => s.set);
  const storeSelectBot = useStore((s) => s.selectBot);
  // Picking a bot (even the one already selected) leaves the Tasks view.
  const selectBot = useCallback((id: string) => { useConfigUI.getState().setView('chat'); storeSelectBot(id); }, [storeSelectBot]);
  const setModal = useStore((s) => s.setModal);
  const voiceBotId = useLocalConversation((s) => (s.status !== 'off' && s.status !== 'error' ? s.botId : null));
  const voiceStatus = useLocalConversation((s) => s.status);
  const openTasks = useOpenTaskCount();
  const [accountMenu, setAccountMenu] = useState(false);
  const logout = async () => { await api.logout().catch(() => {}); location.reload(); };

  const ordered = [...bots].sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || b.lastActivityAt - a.lastActivityAt);
  const liveCount = ordered.filter((b) => live[b.id]?.isRunning || voiceBotId === b.id).length;
  const routinesOn = Object.values(routines).reduce((n, list) => n + list.filter((r) => r.enabled).length, 0);
  const homes = bots.filter((b) => b.kind !== 'room').length;
  const primaryName = bots.find((b) => b.isPrimary)?.name ?? 'Zoey';

  return (
    <aside className={`sidebar${collapsed ? ' is-collapsed' : ''}`}>
      <div className="sidebar__titlebar">
        <TrafficLights />
        <div className="sidebar__controls">
          {collapsed && (
            <button type="button" className="icon-btn icon-btn--plain" onClick={() => setModal('search')} aria-label="Search" title="Search (⌘K)">
              <Icon name="search" opacity={0.66} />
            </button>
          )}
          <button type="button" className="icon-btn icon-btn--plain" onClick={() => set({ sidebarCollapsed: !collapsed })} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} title="Toggle sidebar (⌘B)">
            <Icon name="sidebar" opacity={0.66} />
          </button>
        </div>
      </div>

      <div className="sidebar__scroll">
        {!collapsed && (
          <button type="button" className="sidebar__search" onClick={() => setModal('search')} aria-label="Search bots, tasks, routines" title="Search (⌘K)">
            <Icon name="search" size={13} opacity={0.66} />
            <span className="sidebar__search-text">Search bots, tasks, routines</span>
            <kbd>⌘K</kbd>
          </button>
        )}

        {!collapsed && <div className="nav-h">Bots <span className="nav-h__count">{liveCount ? `${liveCount} live · ` : ''}{bots.length}</span></div>}
        <div className="bot-list" role="list">
          {ordered.map((b) => (
            <BotRow key={b.id} bot={b} selected={selectedBotId === b.id} live={live[b.id]} voiceStatus={voiceBotId === b.id ? voiceStatus : null} collapsed={collapsed} onSelect={selectBot} />
          ))}
          <button type="button" className={`bot-row bot-row--ghost${collapsed ? ' is-rail' : ''}`} onClick={() => setModal('create')} title="Create a bot">
            <span className="bot-row__avatar bot-row__avatar--ghost" aria-hidden><Icon name="plus" size={14} opacity={0.66} /></span>
            {!collapsed && (
              <span className="bot-row__text">
                <span className="bot-row__name">Create a bot</span>
                <span className="bot-row__sub">Give it a job — research, inbox triage…</span>
              </span>
            )}
          </button>
        </div>

        {!collapsed && <div className="nav-h nav-h--gap">Workspace</div>}
        <nav className="nav" aria-label="Workspace">
          <NavItem id="tasks" label="Tasks" badge={openTasks > 0 ? `${openTasks} active` : null} active={inTasks} collapsed={collapsed} onClick={() => useConfigUI.getState().setView(inTasks ? 'chat' : 'tasks')}>
            <Glyph name="tasks" size={16} />
          </NavItem>
          <NavItem id="routines" label="Routines" badge={routinesOn > 0 ? `${routinesOn} on` : null} collapsed={collapsed} onClick={() => openDetailsTab('routines')}>
            <Icon name="clock" size={15} />
          </NavItem>
          <NavItem id="library" label="Library" collapsed={collapsed} onClick={() => openDetailsTab('library')}>
            <Glyph name="folder" size={16} />
          </NavItem>
          <NavItem id="channels" label="Channels" badge="Web" collapsed={collapsed} onClick={() => openDetailsTab('channels')}>
            <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden {...STROKE}><path d="M2.5 8.5 7 3.5l4 4 2.5-2.5" /><path d="M2.5 12.5h11" /></svg>
          </NavItem>
        </nav>
      </div>

      <div className="sidebar__footer">
        <div className="sidebar__fade" />
        {!collapsed && <SidebarFacts homes={homes} primaryName={primaryName} />}
        <div className="sidebar__account">
        <div className="account">
          <button type="button" className="account__btn" onClick={() => setAccountMenu(!accountMenu)} aria-haspopup="menu" aria-expanded={accountMenu} title={user?.email}>
            <span className="account__initials">{initials(user?.name ?? user?.email ?? '')}</span>
            {!collapsed && (
              <span className="account__text">
                <span className="account__name">{user?.name ?? user?.email}</span>
                <span className="account__sub">This Mac · Ollama local</span>
              </span>
            )}
          </button>
          {accountMenu && (
            <Menu
              placement="above"
              onClose={() => setAccountMenu(false)}
              items={[
                { label: 'Settings', hint: '⌘,', onSelect: () => useConfigUI.getState().openAppSettings() },
                { label: 'Connect apps', onSelect: () => setModal('apps') },
                { label: 'Log out', danger: true, onSelect: logout },
              ]}
            >
              <div className="menu__header">{user?.email}</div>
            </Menu>
          )}
        </div>
        {!collapsed && (
          <button type="button" className="icon-btn icon-btn--plain account__gear" onClick={() => useConfigUI.getState().openAppSettings()} aria-label="Settings" title="Settings (⌘,)">
            <Glyph name="gear" size={16} opacity={0.66} />
          </button>
        )}
        </div>
      </div>
    </aside>
  );
}
