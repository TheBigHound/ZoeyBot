import { useCallback, useEffect, useState } from 'react';
import type { Alert, ServerEvent } from '@shared/types';
import { api } from '../lib/api';
import { relativeShort } from '../lib/time';
import { useStore } from '../store';

const HEADLINE_MAX = 120;

/** The first line of an alert without its leading URGENT marker, cut to a strip-sized headline. */
export function alertHeadline(text: string, max = HEADLINE_MAX): string {
  const first = text.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  const stripped = first.replace(/^\W*URGENT\b\W*/i, '').trim() || first;
  return stripped.length > max ? `${stripped.slice(0, max - 1).trimEnd()}…` : stripped;
}

/**
 * Under the chat header: the newest undismissed URGENT alert from any of the person's bots.
 * Loads on mount and again on every SSE `alerts` event (relayed by the store as a window event).
 */
export function AlertStrip() {
  const [alert, setAlert] = useState<Alert | null>(null);
  const selectedBotId = useStore((s) => s.selectedBotId);
  const selectBot = useStore((s) => s.selectBot);

  const load = useCallback(() => {
    api.alerts().then(({ alerts }) => setAlert(alerts[0] ?? null)).catch(() => {});
  }, []);

  useEffect(() => {
    load();
    const onEvent = (e: Event) => { if ((e as CustomEvent<ServerEvent>).detail?.type === 'alerts') load(); };
    window.addEventListener('zoeybot:event', onEvent);
    return () => window.removeEventListener('zoeybot:event', onEvent);
  }, [load]);

  if (!alert) return null;
  const current = alert;
  const dismiss = () => {
    setAlert(null);
    api.dismissAlert(current.id).then(load).catch(load);
  };

  return (
    <div className="alert-strip" role="status" data-alert-id={current.id}>
      <span className="alert-strip__glyph" aria-hidden>⚠</span>
      <span className="alert-strip__who">{current.botName}</span>
      <span className="alert-strip__text" title={current.text}>{alertHeadline(current.text)}</span>
      <span className="alert-strip__time">{relativeShort(current.createdAt)}</span>
      {current.deliveredTo > 0 && <span className="alert-strip__via">sent to Telegram</span>}
      {current.botId !== selectedBotId && (
        <button type="button" className="alert-strip__btn" onClick={() => selectBot(current.botId)}>Open</button>
      )}
      <button type="button" className="alert-strip__btn" onClick={dismiss}>Dismiss</button>
    </div>
  );
}
