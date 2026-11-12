import { useCallback, useEffect, useRef, useState } from 'react';
import type React from 'react';
import type { Bot, EngineInfo, EngineProvider } from '@shared/types';
import { configApi } from '../lib/configApi';
import { useStore } from '../store';
import { Icon } from './Icon';

const KIND: Record<EngineProvider['kind'], string> = { subscription: 'Subscription', api_key: 'API key' };
const STATUS: Record<EngineInfo['status'], string> = { ready: 'ready', starting: 'starting', stopped: 'stopped', error: 'error' };
const EXECUTION: Record<EngineInfo['execution'], string> = { host: 'Mac host' };

/** Hermes toolset names the server accepts, with the labels the chips show. `apps` is the app-side Composio pseudo toolset. */
export const TOOLSETS: { id: string; label: string; title?: string }[] = [
  { id: 'terminal', label: 'Terminal' },
  { id: 'file', label: 'Files' },
  { id: 'web', label: 'Web search' },
  { id: 'browser', label: 'Browser' },
  { id: 'skills', label: 'Skills' },
  { id: 'todo', label: 'Planning' },
  { id: 'memory', label: 'Memory' },
  { id: 'vision', label: 'Vision' },
  { id: 'code_execution', label: 'Code execution' },
  { id: 'delegation', label: 'Subagents' },
  { id: 'chat_history_lookup', label: 'Chat history' },
  { id: 'cronjob', label: 'Cron' },
  { id: 'image_gen', label: 'Image generation' },
  { id: 'x_search', label: 'X search' },
  { id: 'apps', label: 'Connected apps', title: 'Connected apps (Composio) through the app' },
];

/** "/Users/me/proj" → "~/proj" for display; the full path stays in the title. */
export const tilde = (p: string) => p.replace(/^\/Users\/[^/]+(?=\/|$)/, '~');

/** Connected providers first; otherwise the server's order. */
function sortProviders(list: EngineProvider[]): EngineProvider[] {
  return [...list].sort((a, b) => Number(b.connected) - Number(a.connected));
}

/** Human name of the engine's active provider ("Ollama (local)"), falling back to the raw id. */
export function providerName(engine: EngineInfo | null): string | null {
  if (!engine?.provider) return null;
  return engine.providers?.find((p) => p.id === engine.provider)?.name ?? engine.provider;
}

export type EnginePhase = 'loading' | 'ok' | 'unavailable';
export interface EngineController {
  engine: EngineInfo | null;
  phase: EnginePhase;
  /** Quiet refreshes keep what is on screen if the call fails. */
  load: (quiet?: boolean) => () => void;
  apply: (e: EngineInfo, keepDraft?: boolean) => void;
  /** Set by the form while the person has unsaved edits, so quiet refreshes don't clobber them. */
  dirty: React.MutableRefObject<boolean>;
}

/**
 * One fetch of a bot's engine info, shared by the identity line and the Engine tab so the panel makes a
 * single request. Polls while the agent is starting.
 */
export function useEngineInfo(bot: Bot): EngineController {
  const [engine, setEngine] = useState<EngineInfo | null>(null);
  const [phase, setPhase] = useState<EnginePhase>('loading');
  const dirty = useRef(false);
  const botId = bot.id;

  const apply = useCallback((e: EngineInfo, keepDraft = false) => {
    setEngine(e); setPhase('ok');
    if (!keepDraft) dirty.current = false;
    // Keep the bot's model label in step without waiting for the server's `bot` event.
    useStore.setState((s) => ({ bots: s.bots.map((b) => (b.id === e.botId && (b.model !== e.model || b.provider !== e.provider) ? { ...b, model: e.model, provider: e.provider } : b)) }));
  }, []);

  const load = useCallback((quiet = false) => {
    let alive = true;
    if (!quiet) setPhase('loading');
    configApi.engine(botId)
      .then((r) => { if (alive && r?.engine) apply(r.engine, quiet); else if (alive && !quiet) setPhase('unavailable'); })
      .catch(() => { if (alive && !quiet) setPhase('unavailable'); });
    return () => { alive = false; };
  }, [botId, apply]);

  useEffect(() => { dirty.current = false; setEngine(null); return load(); }, [load]);

  // The agent takes a moment to come up after a change or a restart.
  const starting = engine?.status === 'starting';
  useEffect(() => {
    if (!starting) return;
    const t = setInterval(() => load(true), 3000);
    return () => clearInterval(t);
  }, [starting, load]);

  return { engine, phase, load, apply, dirty };
}

/**
 * Engine form (details panel → Engine tab): which provider and model run this bot's agent, signing in to
 * a subscription, and the agent's status. Every call fails soft: if the engine endpoints are missing or
 * down, the section says so and the rest of the panel is unaffected.
 */
export function EngineSettings({ bot, ctl }: { bot: Bot; ctl: EngineController }) {
  const { engine, phase, load, dirty } = ctl;
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState<'save' | 'signin' | 'restart' | 'screen' | 'cwd' | 'tools' | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // Hermes home group: working-dir draft, its inline error, and the server's note (primary home is managed outside the app).
  const [cwd, setCwd] = useState('');
  const [cwdError, setCwdError] = useState<string | null>(null);
  const [serverNote, setServerNote] = useState<string | null>(null);
  // Tool allowlist: optimistic list while a PATCH is in flight, reverted on error.
  const [pendingToolsets, setPendingToolsets] = useState<string[] | null>(null);
  const [toolsError, setToolsError] = useState<string | null>(null);
  const botId = bot.id;

  // Draft follows the server's values unless the person is mid-edit.
  const srvProvider = engine?.provider ?? '';
  const srvModel = engine?.model ?? '';
  const srvCwd = engine?.cwd ?? '';
  useEffect(() => { if (!dirty.current) { setProvider(srvProvider); setModel(srvModel); } }, [srvProvider, srvModel, dirty]);
  useEffect(() => { setCwd(srvCwd); }, [srvCwd]);
  useEffect(() => { setNote(null); setCwdError(null); setServerNote(null); setPendingToolsets(null); setToolsError(null); }, [botId]);

  const apply = useCallback((e: EngineInfo, keepDraft = false) => {
    ctl.apply(e, keepDraft);
    if (!keepDraft || !dirty.current) { setProvider(e.provider ?? ''); setModel(e.model ?? ''); }
  }, [ctl, dirty]);

  if (phase !== 'ok' || !engine) {
    return (
      <div className="panel-card">
        <div className="panel-empty engine__empty">
          {phase === 'loading' ? 'Checking…' : (
            <>
              <span>Engine unavailable</span>
              <button type="button" className="link-btn link-btn--small" onClick={() => load()}>Try again</button>
            </>
          )}
        </div>
      </div>
    );
  }

  const providers = sortProviders(engine.providers ?? []);
  const selected = providers.find((p) => p.id === provider) ?? null;
  const suggestions = selected?.models ?? [];
  const wantProvider = provider && provider !== (engine.provider ?? '') ? provider : undefined;
  const wantModel = model.trim() && model.trim() !== (engine.model ?? '') ? model.trim() : undefined;
  const changed = !!wantProvider || !!wantModel;
  const openSubscriptions = providers.filter((p) => p.kind === 'subscription' && !p.connected);
  const signInTo = selected && selected.kind === 'subscription' && !selected.connected ? selected : null;
  const listId = `engine-models-${botId}`;

  const pickProvider = (id: string) => {
    dirty.current = true; setNote(null); setProvider(id);
    const next = providers.find((p) => p.id === id);
    // A model from another provider will not work here, so start from this provider's first suggestion.
    if (next?.models.length && !next.models.includes(model.trim())) setModel(next.models[0]);
  };

  const save = async () => {
    if (!changed || busy) return;
    setBusy('save'); setNote(null);
    try { const r = await configApi.setEngine(botId, { ...(wantProvider ? { provider: wantProvider } : {}), ...(wantModel ? { model: wantModel } : {}) }); dirty.current = false; apply(r.engine); }
    catch (e) { setNote(`Couldn’t save: ${(e as Error).message || 'the engine did not answer'}`); }
    finally { setBusy(null); }
  };

  // Hermes signs in interactively in the person's own Terminal; the server answers with the command to run.
  const signIn = async () => {
    if (busy) return;
    setBusy('signin'); setNote(null);
    try { await configApi.engineLogin(botId, signInTo?.id); load(true); }
    catch (e) { setNote((e as Error).message || 'The engine did not answer.'); }
    finally { setBusy(null); }
  };

  const restart = async () => {
    if (busy) return;
    setBusy('restart'); setNote(null);
    try { const r = await configApi.restartEngine(botId); apply(r.engine, true); }
    catch (e) { setNote(`Couldn’t restart: ${(e as Error).message || 'the engine did not answer'}`); }
    finally { setBusy(null); }
  };

  const useThisScreen = async () => {
    if (busy) return;
    setBusy('screen'); setNote(null);
    try { const r = await configApi.stopOwnScreen(botId); apply(r.engine, true); }
    catch (e) { setNote(`Couldn’t stop the screen: ${(e as Error).message || 'the engine did not answer'}`); }
    finally { setBusy(null); }
  };

  const starting = engine.status === 'starting';
  const wantCwd = cwd.trim();
  const cwdChanged = wantCwd !== (engine.cwd ?? '');
  const saveCwd = async () => {
    if (!cwdChanged || busy) return;
    setBusy('cwd'); setCwdError(null);
    try { const r = await configApi.setEngine(botId, { cwd: wantCwd }); apply(r.engine, true); setServerNote(r.note ?? null); }
    catch (e) { setCwdError((e as Error).message || 'The engine did not answer.'); }
    finally { setBusy(null); }
  };

  const toolsets = pendingToolsets ?? engine.toolsets ?? [];
  const toolsLocked = busy === 'tools' || starting;
  const toggleToolset = async (id: string) => {
    if (toolsLocked) return;
    const on = toolsets.includes(id);
    const next = on ? toolsets.filter((t) => t !== id) : [...toolsets, id];
    setPendingToolsets(next); setBusy('tools'); setToolsError(null);
    try { const r = await configApi.setEngine(botId, { toolsets: next }); apply(r.engine, true); setServerNote(r.note ?? null); }
    catch (e) { setToolsError((e as Error).message || 'The engine did not answer.'); }
    finally { setPendingToolsets(null); setBusy(null); }
  };

  return (
    <div className="panel-card engine">
      <div className="panel-row panel-row--setting">
        <span>Provider</span>
        <span className="mini-select mini-select--native engine__select">
          <span>{selected?.name ?? (provider || 'Default')}</span>
          <Icon name="chev_down" size={10} opacity={0.66} />
          <select aria-label="Provider" value={provider} onChange={(e) => pickProvider(e.target.value)}>
            {!selected && <option value={provider}>{provider || 'Default'}</option>}
            {providers.map((p) => <option key={p.id} value={p.id}>{p.name} · {KIND[p.kind]} · {p.connected ? 'Connected' : 'Not connected'}</option>)}
          </select>
        </span>
      </div>
      {selected && (
        <div className={`engine__conn${selected.connected ? ' is-on' : ''}`}>
          <i aria-hidden />
          <span>{selected.connected ? 'Connected' : 'Not connected'} · {KIND[selected.kind]}</span>
        </div>
      )}
      <div className="panel-row panel-row--setting">
        <label htmlFor={`${listId}-input`}>Model</label>
        <input
          id={`${listId}-input`} className="engine__model" list={listId} value={model} spellCheck={false} autoComplete="off"
          placeholder={suggestions[0] ?? 'Model id'}
          onChange={(e) => { dirty.current = true; setNote(null); setModel(e.target.value); }}
          onKeyDown={(e) => { if (e.key === 'Enter') save(); }}
        />
        <datalist id={listId}>{suggestions.map((m) => <option key={m} value={m} />)}</datalist>
      </div>
      <div className="engine__actions">
        <button type="button" className="btn btn--sm btn--bot" onClick={save} disabled={!changed || busy === 'save'}>{busy === 'save' ? 'Saving…' : 'Save'}</button>
        {changed && <button type="button" className="link-btn link-btn--small" onClick={() => { dirty.current = false; setNote(null); setProvider(engine.provider ?? ''); setModel(engine.model ?? ''); }}>Undo</button>}
      </div>
      {(signInTo || openSubscriptions.length > 0) && (
        <button type="button" className="panel-row panel-row--action engine__signin" onClick={signIn} disabled={busy === 'signin'}>
          <Icon name="monitor" size={14} opacity={0.56} />
          {busy === 'signin' ? 'Opening sign-in…' : signInTo ? `Sign in to ${signInTo.name}…` : 'Sign in to a subscription…'}
        </button>
      )}
      {engine.ownScreen && (
        <div className="engine__notice">
          <span>{bot.name} has Hermes’ private virtual screen switched on for its computer-use tool.</span>
          <button type="button" className="link-btn link-btn--small" onClick={useThisScreen} disabled={busy === 'screen'}>{busy === 'screen' ? 'Stopping…' : 'Stop that screen'}</button>
        </div>
      )}
      {note && <div className="voice-error" role="alert">{note}</div>}

      <div className="engine-group" data-group="home">
        <div className="engine-group__h">Hermes home</div>
        <div className="field">
          <span className="field__lab">Home</span>
          <code className="field__mono" title={engine.home}>{engine.home ? tilde(engine.home) : '—'}</code>
        </div>
        <div className="field">
          <span className="field__lab">Execution</span>
          <span className="select select--static">{EXECUTION[engine.execution] ?? engine.execution}</span>
        </div>
        <div className="field field--edit">
          <label className="field__lab" htmlFor={`${listId}-cwd`}>Working dir</label>
          <span className="field__ctl">
            <input
              id={`${listId}-cwd`} className="field__input" value={cwd} spellCheck={false} autoComplete="off" placeholder="/absolute/path"
              aria-invalid={cwdError ? true : undefined} title={engine.cwd}
              onChange={(e) => { setCwdError(null); setCwd(e.target.value); }}
              onKeyDown={(e) => { if (e.key === 'Enter') saveCwd(); }}
            />
            <button type="button" className="btn btn--sm btn--bot" data-action="save-cwd" onClick={saveCwd} disabled={!cwdChanged || busy === 'cwd' || starting}>{busy === 'cwd' ? 'Saving…' : 'Save'}</button>
          </span>
        </div>
        {cwdError && <div className="engine__error" role="alert">{cwdError}</div>}
        {serverNote && <div className="engine__hint engine__hint--note" role="note">{serverNote}</div>}
      </div>

      <div className="engine-group" data-group="tools">
        <div className="engine-group__h">Tool allowlist</div>
        <div className="chips" role="group" aria-label="Tool allowlist">
          {TOOLSETS.map((t) => {
            const on = toolsets.includes(t.id);
            return (
              <button
                key={t.id} type="button" className={`chip ${on ? 'is-on' : 'is-off'}`} data-toolset={t.id} aria-pressed={on}
                title={t.title ?? (on ? `${t.label} · on` : `${t.label} · off`)} disabled={toolsLocked} onClick={() => toggleToolset(t.id)}
              >
                {t.label}
              </button>
            );
          })}
        </div>
        {toolsError && <div className="engine__error" role="alert">{toolsError}</div>}
        <div className="engine__hint">{starting ? 'Restarting this bot’s agent…' : 'Changes restart this bot’s agent.'}</div>
      </div>
      <div className="engine__meta">
        <span className={`engine__state is-${engine.status}`} title={engine.version ? `Hermes ${engine.version}` : undefined}>
          <i aria-hidden />
          Hermes · profile {engine.profile} · {STATUS[engine.status] ?? engine.status}
        </span>
        {(engine.status === 'error' || engine.status === 'stopped') && (
          <button type="button" className="link-btn link-btn--small" onClick={restart} disabled={busy === 'restart'}>{busy === 'restart' ? 'Restarting…' : 'Restart agent'}</button>
        )}
      </div>
      {engine.status === 'error' && engine.error && <div className="engine__error">{engine.error}</div>}
    </div>
  );
}