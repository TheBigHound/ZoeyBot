import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Bot, ChannelsStatus, LiveState, Routine, Row } from '@shared/types';
import { BotAvatarFor } from '../avatar/BotAvatar';
import { api, openPopup } from '../lib/api';
import { botVars } from '../lib/colors';
import { computerStatusText } from '../lib/computer';
import { activityStatus } from '../lib/phrases';
import { relativeShort } from '../lib/time';
import { displayName, sortedRows, useSelectedBot, useStore } from '../store';
import { Icon } from './Icon';
import { VoiceSettings } from './VoiceSettings';
import { ComputerScreen, type ScreenMode } from './ComputerViewer';
import { EngineSettings, providerName, useEngineInfo } from './EngineSettings';
import { MembersCard } from './MembersCard';
import { useConfigUI } from '../configStore';
import { LibraryTab } from './config/LibraryTab';
import { BotTasks } from './config/TasksView';

// Other files import this from here; it lives in lib/computer so the viewer can use it too.
export { computerStatusText };

export type DetailsTab = 'activity' | 'routines' | 'channels' | 'engine' | 'library';
const TABS: DetailsTab[] = ['activity', 'routines', 'channels', 'engine', 'library'];
const LS_TAB = 'hq.detailsTab';
/** Window event the sidebar dispatches to open a tab: `new CustomEvent('hq:details-tab', { detail: 'channels' })`. */
export const DETAILS_TAB_EVENT = 'hq:details-tab';
const isTab = (v: unknown): v is DetailsTab => typeof v === 'string' && (TABS as string[]).includes(v);

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} className={`toggle${on ? ' is-on' : ''}`} onClick={() => onChange(!on)}>
      <span className="toggle__knob" />
    </button>
  );
}

/** "tomorrow", "in 2h", "in 12m": when a routine next fires. */
function nextRunLabel(ts: number, now = Date.now()): string {
  const s = Math.max(0, (ts - now) / 1000);
  if (s < 90) return 'in a minute';
  if (s < 3600) return `in ${Math.round(s / 60)}m`;
  if (s < 86400) {
    const dayAfter = new Date(now); dayAfter.setHours(24, 0, 0, 0);
    return ts >= dayAfter.getTime() ? 'tomorrow' : `in ${Math.round(s / 3600)}h`;
  }
  if (s < 172800) return 'tomorrow';
  return `in ${Math.round(s / 86400)}d`;
}

function RoutineRow({ r }: { r: Routine }) {
  const [enabled, setEnabled] = useState(r.enabled);
  useEffect(() => setEnabled(r.enabled), [r.enabled]);
  const toggle = async (v: boolean) => {
    setEnabled(v);
    try { await api.setRoutine(r.id, v); } catch { setEnabled(!v); }
  };
  const when = r.description || r.schedule;
  const meta = r.nextRunAt ? nextRunLabel(r.nextRunAt) : r.lastRunAt ? `ran ${relativeShort(r.lastRunAt)} ago` : null;
  return (
    <div className="drow drow--routine" title={r.prompt}>
      <span className="drow__ic"><Icon name={/gmail|email|mail/i.test(when) ? 'mail' : /^when\b|trigger|new /i.test(when) ? 'bolt' : 'clock'} size={14} opacity={0.72} /></span>
      <span className="drow__text">
        <span className="drow__title">{r.name}</span>
        <span className="drow__sub">
          {enabled ? when : 'Paused'}
          {enabled && meta && <span className="drow__meta"> · {meta}</span>}
        </span>
      </span>
      <Toggle on={enabled} onChange={toggle} label={`${r.name} ${enabled ? 'on' : 'off'}`} />
    </div>
  );
}

/** One line of what the bot is doing on its screen right now, or null while idle. */
function doingNow(live: LiveState | undefined, rows: Row[]): string | null {
  if (!live?.isRunning) return null;
  const status = activityStatus(live, rows);
  const detail = live.caption?.trim();
  return detail && !status.includes(detail) ? `${status} · ${detail}` : status;
}

const TgGlyph = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden><path d="M14 2.5 2 7.2l3.6 1.4L7 13l2.1-2.6 3 2.2z" /></svg>
);
const WebGlyph = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden><circle cx="8" cy="8" r="5.5" /><path d="M2.5 8h11M8 2.5c2 2 2 9 0 11M8 2.5c-2 2-2 9 0 11" /></svg>
);
const SlackGlyph = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden><path d="M5.5 2v12M10.5 2v12M2 5.5h12M2 10.5h12" /></svg>
);
const PopOutGlyph = () => (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden><path d="M6 3H3.5A1.5 1.5 0 0 0 2 4.5v8A1.5 1.5 0 0 0 3.5 14h8a1.5 1.5 0 0 0 1.5-1.5V10M9 2h5v5M14 2 7.5 8.5" /></svg>
);

/** How many channels count as live: the web app always, Telegram once it answers to a username, Slack when connected. */
export function connectedChannelCount(c: ChannelsStatus | null): number {
  if (!c) return 1;
  return 1 + (c.telegram.configured && c.telegram.username ? 1 : 0) + (c.slack.connected ? 1 : 0);
}

function ChannelRows({ channels, failed }: { channels: ChannelsStatus | null; failed: boolean }) {
  const [explain, setExplain] = useState(false);
  const addSlack = async () => {
    const popup = openPopup('about:blank');
    try { const { redirectUrl } = await api.connect('slack'); if (popup) popup.location.href = redirectUrl; } catch { popup?.close(); }
  };
  const tg = channels?.telegram;
  const pending = !channels && !failed;
  let tgSub: ReactNode;
  if (pending) tgSub = 'Checking…';
  else if (tg?.configured && tg.username && tg.chatAllowlisted) tgSub = <><i className="okdot" aria-hidden />@{tg.username} · notifications {tg.notifications ? 'on' : 'off'}</>;
  else if (tg?.configured && tg.username) tgSub = `Send /start to @${tg.username} to finish setup`;
  else if (tg?.configured) tgSub = 'Set up · waiting for Telegram to answer';
  else tgSub = 'Not set up';
  const tgNeedsSetup = !pending && !tg?.configured;
  return (
    <div className="dlist">
      <div className="drow">
        <span className="drow__ic drow__ic--web"><WebGlyph /></span>
        <span className="drow__text">
          <span className="drow__title">Web · this Mac</span>
          <span className="drow__sub"><i className="okdot" aria-hidden />Connected · you’re here</span>
        </span>
      </div>
      <div className="drow">
        <span className="drow__ic drow__ic--tg"><TgGlyph /></span>
        <span className="drow__text">
          <span className="drow__title">Telegram</span>
          <span className="drow__sub">{tgSub}</span>
        </span>
        {tgNeedsSetup && <button type="button" className="drow__cta" data-channel="telegram-setup" onClick={() => setExplain((v) => !v)} aria-expanded={explain}>Set up</button>}
      </div>
      {tgNeedsSetup && explain && (
        <div className="drow__note" role="note">Add <code>TELEGRAM_BOT_TOKEN</code> to <code>.env.local</code> and restart. Then message your bot on Telegram and send <code>/start</code>.</div>
      )}
      <div className="drow">
        <span className="drow__ic drow__ic--sl"><SlackGlyph /></span>
        <span className="drow__text">
          <span className="drow__title">Slack</span>
          <span className="drow__sub">{pending ? 'Checking…' : channels?.slack.connected ? <><i className="okdot" aria-hidden />Connected</> : 'Not connected'}</span>
        </span>
        {!channels?.slack.connected && <button type="button" className="drow__cta" data-channel="slack-add" onClick={addSlack}>Add</button>}
      </div>
    </div>
  );
}

function useChannels(): { channels: ChannelsStatus | null; failed: boolean } {
  const version = useStore((s) => s.connectionsVersion);
  const [channels, setChannels] = useState<ChannelsStatus | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    api.channels().then((c) => { if (alive) { setChannels(c); setFailed(false); } }).catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [version]);
  return { channels, failed };
}

function useRememberedTab(): [DetailsTab, (t: DetailsTab) => void] {
  const [tab, setTabState] = useState<DetailsTab>(() => { try { const v = localStorage.getItem(LS_TAB); return isTab(v) ? v : 'activity'; } catch { return 'activity'; } });
  const setTab = useCallback((t: DetailsTab) => { setTabState(t); try { localStorage.setItem(LS_TAB, t); } catch { /* ignore */ } }, []);
  useEffect(() => {
    const on = (e: Event) => { const d = (e as CustomEvent).detail; if (isTab(d)) setTab(d); };
    window.addEventListener(DETAILS_TAB_EVENT, on);
    return () => window.removeEventListener(DETAILS_TAB_EVENT, on);
  }, [setTab]);
  return [tab, setTab];
}

export function DetailsPanel() {
  const bot = useSelectedBot();
  if (!bot) return null;
  return <DetailsPanelFor key={bot.id} bot={bot} />;
}

function DetailsPanelFor({ bot }: { bot: Bot }) {
  const routines = useStore((s) => s.routines[bot.id]);
  const computer = useStore((s) => s.computer);
  const live = useStore((s) => s.live[bot.id]);
  const transcript = useStore((s) => s.transcripts[bot.id]);
  const viewerOpen = useStore((s) => s.viewerOpen);
  const set = useStore((s) => s.set);
  const isRoom = bot.kind === 'room';
  const [tab, setTab] = useRememberedTab();
  const engineCtl = useEngineInfo(bot);
  const { channels, failed } = useChannels();
  const rows = useMemo(() => sortedRows(transcript), [transcript]);

  const engine = engineCtl.engine;
  const model = engine?.model ?? bot.model;
  const provider = providerName(engine) ?? bot.provider;
  const providerOk = engine ? engine.status === 'ready' && (engine.providers?.find((p) => p.id === engine.provider)?.connected ?? true) : false;
  const running = computer?.status === 'running';
  const waking = computer?.status === 'starting' || computer?.status === 'resuming' || computer?.status === 'creating';
  const stateText = computerStatusText(computer);
  const doing = doingNow(live, rows);
  const enabledCount = routines?.filter((r) => r.enabled).length ?? 0;
  const upNext = (routines ?? []).slice(0, 4);
  const effectiveTab: DetailsTab = isRoom && tab === 'engine' ? 'activity' : tab;

  const openComputer = (mode: ScreenMode) => set({ viewerOpen: true, viewerMode: mode, viewerHint: null });
  const popOut = () => set({ viewerOpen: true, viewerMode: 'watch', viewerHint: null });

  const tabLabel: Record<DetailsTab, string> = { activity: 'Activity', routines: 'Routines', channels: 'Channels', engine: 'Engine', library: 'Library' };
  const tabCount: Partial<Record<DetailsTab, number>> = { routines: enabledCount, channels: connectedChannelCount(channels) };
  const visibleTabs = TABS.filter((t) => !(isRoom && t === 'engine'));

  return (
    <aside className="details" style={botVars(bot.avatarColor)} aria-label="Conversation details">
      <div className="details__top">
        <span className="details__title" title={isRoom ? displayName(bot) : `${bot.name}’s computer`}>{isRoom ? displayName(bot) : `${bot.name}’s computer`}</span>
        <span className="details__sp" />
        {!isRoom && (
          <button type="button" className="icon-btn details__iconbtn" onClick={popOut} aria-label="Pop out" title="Open the large view">
            <PopOutGlyph />
          </button>
        )}
        <button type="button" className="icon-btn details__iconbtn" onClick={() => set({ detailsOpen: false })} aria-label="Close details" title="Close">
          <Icon name="close" opacity={0.92} />
        </button>
      </div>

      {isRoom ? (
        <div className="details__ident details__ident--room">
          <span className="details__ident-avatar"><BotAvatarFor bot={bot} size={36} /></span>
          <div className="details__ident-text">
            <div className="details__ident-name">{bot.name}{bot.label && <span className="details__ident-role">{bot.label}</span>}</div>
            <div className="details__ident-sub">Group chat</div>
          </div>
        </div>
      ) : (
        <div className="details__fixed">
          <div className={`details__screen${running ? ' is-running' : ''}`}>
            <ComputerScreen bot={bot} variant="panel" paused={viewerOpen} onExpand={openComputer} />
            {/* The stream's own phase-accurate "Live" badge (inside ComputerScreen) is the only live indicator; VM status alone is not a live frame. */}
            {!running && (
              <span className={`details__screen-state${waking ? ' is-waking' : ''}`} role="status">{stateText}</span>
            )}
            {doing && <span className="details__doing" title={doing}><i aria-hidden />{doing}</span>}
            <button type="button" className="details__openbtn" onClick={() => openComputer('watch')}>Open <Icon name="chev_right" size={10} opacity={0.8} /></button>
          </div>
          <div className="details__ident">
            <span className="details__ident-avatar">
              <BotAvatarFor bot={bot} size={36} />
              <i className={`details__state-dot${running ? ' is-on' : waking ? ' is-waking' : ''}`} aria-hidden />
            </span>
            <div className="details__ident-text">
              <div className="details__ident-name" title={displayName(bot)}>{bot.name}{bot.label && <span className="details__ident-role">{bot.label}</span>}</div>
              <div className="details__ident-sub">
                <i className={`okdot${running ? '' : waking ? ' is-warn' : ' is-off'}`} aria-hidden />
                <span>{stateText}</span>
                {model && <><span className="details__sep">·</span><code className="details__code" title={model}>{model}</code></>}
                {provider && <><span className="details__sep">·</span><span className="details__provider">{provider}</span></>}
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="details__tabstrip" role="tablist" aria-label="Details">
        {visibleTabs.map((t) => (
          <button key={t} type="button" role="tab" data-tab={t} aria-selected={effectiveTab === t} className={`details__tab${effectiveTab === t ? ' is-on' : ''}`} onClick={() => setTab(t)}>
            {tabLabel[t]}
            {tabCount[t] ? <span className="details__tab-n">{tabCount[t]}</span> : null}
          </button>
        ))}
      </div>

      <div className="details__body" role="tabpanel">
        {effectiveTab === 'activity' && (
          <>
            <section className="dsec">
              <div className="dsec__h"><span>Up next</span><button type="button" className="dsec__link" onClick={() => setTab('routines')}>Manage</button></div>
              <div className="dlist">
                {upNext.length ? upNext.map((r) => <RoutineRow key={r.id} r={r} />) : (
                  <div className="panel-empty">Nothing scheduled. Try asking in chat, for example “send me a summary every weekday at 8am”.</div>
                )}
              </div>
            </section>
            {isRoom && (
              <section className="dsec">
                <div className="dsec__h"><span>Members</span></div>
                <MembersCard room={bot} />
              </section>
            )}
            <section className="dsec">
              <div className="dsec__h"><span>Channels</span><button type="button" className="dsec__link" onClick={() => setTab('channels')}>All</button></div>
              <ChannelRows channels={channels} failed={failed} />
            </section>
            {!isRoom && (
              <section className="dsec">
                <div className="dsec__h"><span>Engine</span><button type="button" className="dsec__link" onClick={() => setTab('engine')}>Change</button></div>
                <div className="dkv-grid">
                  <div className="dkv">
                    <div className="dkv__k">Provider</div>
                    <div className="dkv__v"><i className={`okdot${providerOk ? '' : ' is-off'}`} aria-hidden />{provider ?? (engineCtl.phase === 'loading' ? 'Checking…' : 'Default')}</div>
                  </div>
                  <div className="dkv">
                    <div className="dkv__k">Model</div>
                    <div className="dkv__v">{model ? <code className="details__code" title={model}>{model}</code> : <span className="details__muted">Default</span>}</div>
                  </div>
                </div>
              </section>
            )}
            <BotTasks bot={bot} />
          </>
        )}
        {effectiveTab === 'routines' && (
          <section className="dsec">
            <div className="dsec__h">
              <span>Routines</span>
              <button type="button" className="dsec__link" onClick={() => useConfigUI.getState().openBotSettings(bot.id, 'routines')}>Edit…</button>
            </div>
            <div className="dlist">
              {routines?.length ? routines.map((r) => <RoutineRow key={r.id} r={r} />) : (
                <div className="panel-empty">Nothing scheduled. Try asking in chat, for example “send me a summary every weekday at 8am”.</div>
              )}
            </div>
          </section>
        )}
        {effectiveTab === 'channels' && (
          <section className="dsec">
            <div className="dsec__h"><span>Channels</span></div>
            <ChannelRows channels={channels} failed={failed} />
            {failed && <div className="panel-empty">Couldn’t check channel status. The app itself is still connected.</div>}
          </section>
        )}
        {effectiveTab === 'engine' && !isRoom && (
          <>
            <section className="dsec">
              <div className="dsec__h"><span>Engine</span><button type="button" className="dsec__link" onClick={() => useConfigUI.getState().openBotSettings(bot.id)}>Bot settings…</button></div>
              <EngineSettings bot={bot} ctl={engineCtl} />
            </section>
            <section className="dsec">
              <div className="dsec__h"><span>Voice chat</span></div>
              <VoiceSettings bot={bot} />
            </section>
          </>
        )}
        {effectiveTab === 'library' && <LibraryTab bot={bot} />}
      </div>
    </aside>
  );
}
