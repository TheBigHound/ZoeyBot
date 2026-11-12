import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Bot } from '@shared/types';
import { api } from '../lib/api';
import { displayName, useStore } from '../store';
import { Icon } from './Icon';
import { Menu } from './Menu';
import { endCall, isCallActive, startCall, useVoice } from '../voice/call';
import { useDictation } from '../voice/dictation';
import { voiceApi, type VoiceOptions } from '../voice/api';
import { cancelReadAloud } from '../voice/readAloudStore';
import { LocalConversationPanel } from './LocalConversationPanel';
import { endLocalConversation, startLocalConversation, useLocalConversation } from '../voice/localConversationStore';
import { supportsLocalConversation } from '../voice/localConversationBrowser';

const MAX_H = 200;
const drafts = new Map<string, string>();

export function Composer({ bot, running }: { bot: Bot; running: boolean }) {
  const [text, setText] = useState(() => drafts.get(bot.id) ?? '');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const [voiceOptions, setVoiceOptions] = useState<VoiceOptions | null>(null);
  useEffect(() => { voiceApi.options().then(setVoiceOptions).catch(() => {}); }, []);
  const ref = useRef<HTMLTextAreaElement>(null);
  const setModal = useStore((s) => s.setModal);

  // Per-bot drafts.
  useEffect(() => { setText(drafts.get(bot.id) ?? ''); setError(null); ref.current?.focus(); }, [bot.id]);
  useEffect(() => { drafts.set(bot.id, text); }, [bot.id, text]);
  useEffect(() => () => endLocalConversation(), [bot.id]);

  // Auto-grow.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(el.scrollHeight, MAX_H)}px`;
    el.style.overflowY = el.scrollHeight > MAX_H ? 'auto' : 'hidden';
  }, [text]);

  // ⌘I focuses the prompt.
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'i') { e.preventDefault(); ref.current?.focus(); } };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);

  const send = async () => {
    const t = text.trim();
    if (!t || sending) return;
    setSending(true); setError(null);
    try {
      endLocalConversation();
      cancelReadAloud();
      await api.send(bot.id, t);
      setText('');
      drafts.delete(bot.id);
    } catch (e) {
      setError((e as Error).message || 'Message failed to send');
    } finally {
      setSending(false);
      ref.current?.focus();
    }
  };

  const stop = () => { endLocalConversation(); void api.interrupt(bot.id).catch((e) => setError(e.message)); };
  const fresh = () => { endLocalConversation(); void api.fresh(bot.id).catch((e) => setError(e.message)); };

  // Dictation: insert the transcript at the cursor.
  const insertText = (t: string) => {
    const el = ref.current;
    setText((cur) => {
      const start = el && document.activeElement === el ? el.selectionStart : cur.length;
      const end = el && document.activeElement === el ? el.selectionEnd : cur.length;
      const before = cur.slice(0, start);
      const after = cur.slice(end);
      const pre = before && !/\s$/.test(before) ? ' ' : '';
      const post = after && !/^\s/.test(after) ? ' ' : '';
      requestAnimationFrame(() => { if (el) { const pos = before.length + pre.length + t.length; el.focus(); el.setSelectionRange(pos, pos); } });
      return before + pre + t + post + after;
    });
  };
  const dictation = useDictation(insertText, setError, bot.voiceLanguage, bot.id);
  const inCall = useVoice((s) => isCallActive(s) && s.botId === bot.id);
  const localInCall = useLocalConversation((s) => s.botId === bot.id && s.status !== 'off' && s.status !== 'error');
  const localAvailable = supportsLocalConversation(voiceOptions);
  const canStartVoice = localAvailable || !!voiceOptions?.capabilities.calls;

  const hasText = text.trim().length > 0;
  const multiline = text.includes('\n') || (ref.current?.scrollHeight ?? 0) > 30;

  return (
    <div className="composer-area">
      <LocalConversationPanel botId={bot.id} name={bot.name} />
      {error && <div className="composer__error">{error} <button type="button" className="link-btn" onClick={() => setError(null)}>Dismiss</button></div>}
      <div className={`composer${multiline ? ' is-multiline' : ''}`}>
        <div className="composer__left">
          <span className="composer__plus-anchor">
            <button type="button" className="composer__btn" onClick={() => setMenu(!menu)} aria-label="More actions" aria-expanded={menu}>
              <Icon name="composer_plus" opacity={0.56} />
            </button>
            {menu && (
              <Menu
                placement="above"
                onClose={() => setMenu(false)}
                items={[
                  { label: 'New conversation', onSelect: fresh },
                  { label: 'Connect apps', onSelect: () => setModal('apps') },
                ]}
              />
            )}
          </span>
          <textarea
            ref={ref}
            className="composer__input"
            rows={1}
            value={text}
            placeholder={`Message ${displayName(bot)}`}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); }
            }}
            aria-label={`Message ${bot.name}`}
          />
        </div>
        <div className="composer__right">
          <button
            type="button"
            className={`composer__btn${dictation.state === 'recording' ? ' is-recording' : dictation.state === 'starting' ? ' is-starting' : dictation.state === 'transcribing' ? ' is-transcribing' : ''}`}
            aria-label={dictation.state === 'recording' ? 'Stop dictation' : dictation.state === 'starting' ? 'Cancel microphone start' : 'Dictate'}
            aria-pressed={dictation.state === 'recording' || dictation.state === 'starting'}
            aria-busy={dictation.state === 'starting' || dictation.state === 'transcribing'}
            data-dictation={dictation.state}
            title={dictation.state === 'recording' ? 'Release or click to stop · Esc cancels' : dictation.state === 'starting' ? 'Starting microphone… · Esc cancels' : dictation.state === 'transcribing' ? 'Transcribing…' : 'Hold to dictate, or click to start'}
            disabled={localInCall || inCall || dictation.state === 'transcribing' || !voiceOptions?.capabilities.stt}
            onPointerDown={dictation.onPointerDown}
            onPointerUp={dictation.onPointerUp}
            onPointerCancel={dictation.onPointerCancel}
            onKeyDown={dictation.onKeyDown}
            onContextMenu={(e) => e.preventDefault()}
          >
            <Icon name="mic" opacity={0.56} />
          </button>
          {localInCall && !hasText ? (
            <button type="button" className="composer__cta is-in-call" onClick={endLocalConversation} aria-label="End local voice conversation" title="End local voice conversation">
              <Icon name="voice_a" size={16} />
            </button>
          ) : inCall && !hasText ? (
            <button type="button" className="composer__cta is-in-call" onClick={endCall} aria-label="End voice call" title="End voice call">
              <Icon name="voice_a" size={16} />
            </button>
          ) : running && !hasText ? (
            <button type="button" className="composer__cta" onClick={stop} aria-label="Stop" title="Stop">
              <Icon name="stop" size={14} />
            </button>
          ) : (
            <button
              type="button"
              className="composer__cta"
              onClick={hasText ? send : () => localAvailable ? startLocalConversation(bot.id) : startCall(bot.id)}
              disabled={hasText ? sending : !canStartVoice || dictation.state !== 'idle'}
              aria-label={hasText ? 'Send' : localAvailable ? `Start local voice conversation with ${bot.name}` : canStartVoice ? `Start voice chat with ${bot.name}` : 'Voice calls unavailable'}
              title={hasText ? 'Send (Enter)' : localAvailable ? 'Start local turn-based conversation · Whisper + phonon/Zoey' : canStartVoice ? 'Start voice chat' : voiceOptions?.callDisabledReason || 'Voice capabilities unavailable'}
            >
              <Icon name={hasText ? 'arrow_up' : 'voice_a'} size={16} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
