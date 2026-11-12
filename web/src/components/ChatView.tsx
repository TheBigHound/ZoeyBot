import { useEffect, useMemo, useState } from 'react';
import { BotAvatarFor } from '../avatar/BotAvatar';
import { api } from '../lib/api';
import { botVars } from '../lib/colors';
import { sortedRows, useSelectedBot, useStore } from '../store';
import { useConfigUI } from '../configStore';
import { voiceApi, type VoiceOptions } from '../voice/api';
import { AlertStrip } from './AlertStrip';
import { Composer } from './Composer';
import { Icon } from './Icon';
import { Menu } from './Menu';
import { roleFor } from './Sidebar';
import { Transcript } from './Transcript';
import { VoiceCallBar } from './VoiceCallBar';
import { VoiceStatusPill } from './VoiceStatusPill';

export function ChatView() {
  const bot = useSelectedBot();
  const transcript = useStore((s) => (bot ? s.transcripts[bot.id] : undefined));
  const live = useStore((s) => (bot ? s.live[bot.id] : undefined));
  const detailsOpen = useStore((s) => s.detailsOpen);
  const set = useStore((s) => s.set);
  const [menu, setMenu] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [voiceOptions, setVoiceOptions] = useState<VoiceOptions | null>(null);
  const rows = useMemo(() => sortedRows(transcript), [transcript]);
  useEffect(() => { voiceApi.options().then(setVoiceOptions).catch(() => {}); }, []);

  if (!bot) {
    return (
      <main className="chat chat--empty">
        <div className="empty-chat"><div className="empty-chat__sub">No Bot selected.</div></div>
      </main>
    );
  }

  const flash = (t: string) => { setToast(t); setTimeout(() => setToast(null), 2000); };
  const role = roleFor(bot);
  // Only the speech pipeline is local; connected apps and the reasoning provider may be remote, so say no more than that.
  const localSpeech = voiceOptions?.provider === 'local';

  return (
    <main className="chat" style={botVars(bot.avatarColor)}>
      <header className="chat__header">
        <button type="button" className="chat__who" onClick={() => setMenu(!menu)} aria-haspopup="menu" aria-expanded={menu} title="Conversation menu">
          <BotAvatarFor bot={bot} size={26} />
          <span className="chat__title">{bot.name}</span>
          {role && <span className="chat__sess">{role}</span>}
        </button>
        <span className="chat__spacer" />
        <div className="chat__header-right">
          <span data-voice-pill className="chat__voice"><VoiceStatusPill botId={bot.id} options={voiceOptions} /></span>
          <button type="button" className="share-btn" disabled aria-disabled title="Sharing isn’t available yet">Share</button>
          {!detailsOpen && (
            <button type="button" className="icon-btn icon-btn--plain" onClick={() => set({ detailsOpen: true })} aria-label="Show details" title="Show details (⇧⌘,)">
              <Icon name="sidebar" opacity={0.66} style={{ transform: 'scaleX(-1)' }} />
            </button>
          )}
          <span className="chat__more-anchor">
            <button type="button" className="icon-btn icon-btn--plain chat__more" onClick={() => setMenu(!menu)} aria-haspopup="menu" aria-expanded={menu} aria-label="More" title="More">
              <Icon name="more" opacity={0.66} />
            </button>
            {menu && (
              <Menu
                align="right"
                onClose={() => setMenu(false)}
                items={[
                  { label: detailsOpen ? 'Hide details' : 'Show details', hint: '⇧⌘,', onSelect: () => set({ detailsOpen: !detailsOpen }) },
                  { label: 'New conversation', onSelect: () => api.fresh(bot.id).then(() => flash('Started a new conversation')).catch((e) => flash(e.message)) },
                  { label: 'Bot settings', onSelect: () => useConfigUI.getState().openBotSettings(bot.id) },
                ]}
              />
            )}
          </span>
        </div>
      </header>
      <AlertStrip />
      <Transcript bot={bot} rows={rows} live={live} loaded={!!transcript?.loaded} />
      <VoiceCallBar />
      <Composer bot={bot} running={!!live?.isRunning} />
      <div className="composer-hint">
        <span><kbd>Enter</kbd> to send · hold mic to dictate{localSpeech && <> · <kbd>Esc</kbd> ends voice</>}</span>
        {localSpeech && <span>Speech processed on this Mac</span>}
      </div>
      {toast && <div className="toast" role="status">{toast}</div>}
    </main>
  );
}
