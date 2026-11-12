import type { Bot, EngineInfo, LibraryFile, Memory, Routine, Skill, Task, Toolkit } from '@shared/types';
import { ApiError } from './api';

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'include',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = ((await res.json()) as { error?: string }).error ?? msg; } catch { /* not json */ }
    throw new ApiError(res.status, msg);
  }
  return res.json() as Promise<T>;
}

export interface BotSettingsBundle {
  memories: Memory[];
  skills: Skill[];
  routines: Routine[];
  tasks: Task[];
  memory: { lastConsolidatedAt: number | null; historyChars: number; compactAtChars: number; lastCompaction: { method: string; created_at: number } | null };
}

/** One folder of a bot's Library (`<Hermes home>/library` on this Mac). */
export interface LibraryListing { status: 'ok' | 'error'; path: string; files: LibraryFile[]; error?: string }

export type BotPatch = Partial<Pick<Bot, 'name' | 'label' | 'description' | 'instructions' | 'avatarShape' | 'avatarColor' | 'effort' | 'mode'>>;

export interface EnginePatch { provider?: string | null; model?: string | null; cwd?: string; toolsets?: string[] }

export const configApi = {
  settings: (botId: string) => req<BotSettingsBundle>('GET', `/bots/${botId}/settings`),
  updateBot: (botId: string, p: BotPatch) => req<{ bot: Bot }>('PATCH', `/bots/${botId}`, p),
  deleteBot: (botId: string) => req<{ ok: true }>('DELETE', `/bots/${botId}`),
  makePrimary: (botId: string) => req<{ ok: true }>('POST', `/bots/${botId}/primary`),
  fresh: (botId: string) => req<{ ok: true }>('POST', `/bots/${botId}/fresh`),

  deleteMemory: (id: string) => req<{ ok: true }>('DELETE', `/memories/${id}`),

  createSkill: (botId: string, s: Pick<Skill, 'name' | 'description' | 'body'>) => req<{ skill: Skill }>('POST', `/bots/${botId}/skills`, s),
  updateSkill: (id: string, s: Partial<Pick<Skill, 'name' | 'description' | 'body'>>) => req<{ skill: Skill }>('PATCH', `/skills/${id}`, s),
  deleteSkill: (id: string) => req<{ ok: true }>('DELETE', `/skills/${id}`),

  setRoutine: (id: string, enabled: boolean) => req<{ routine: Routine }>('PATCH', `/routines/${id}`, { enabled }),
  runRoutine: (id: string) => req<{ ok: true }>('POST', `/routines/${id}/run`),
  deleteRoutine: (id: string) => req<{ ok: true }>('DELETE', `/routines/${id}`),

  tasks: () => req<{ tasks: Task[] }>('GET', '/tasks'),
  botTasks: (botId: string) => req<{ tasks: Task[] }>('GET', `/bots/${botId}/tasks`),

  files: (botId: string, path = '') => req<LibraryListing>('GET', `/bots/${botId}/files?path=${encodeURIComponent(path)}`),
  downloadFile: (botId: string, path: string) => req<{ url: string }>('POST', `/bots/${botId}/files/download`, { path }),

  engine: (botId: string) => req<{ engine: EngineInfo }>('GET', `/bots/${botId}/engine`),
  /**
   * Changes the agent's provider/model, working directory or toolset allowlist. cwd/toolsets restart the
   * managed gateway (status 'starting' for a bit); for the primary bot they are stored and `note` says so.
   */
  setEngine: (botId: string, p: EnginePatch) => req<{ engine: EngineInfo; note?: string }>('PATCH', `/bots/${botId}/engine`, p),
  /** Asks for the provider's sign-in; the server answers 409 with the Terminal command to run (Hermes signs in interactively). */
  engineLogin: (botId: string, provider?: string) => req<{ ok: true }>('POST', `/bots/${botId}/engine/login`, provider ? { provider } : {}),
  restartEngine: (botId: string) => req<{ engine: EngineInfo }>('POST', `/bots/${botId}/engine/restart`),
  /** Stops the private virtual screen (Hermes "Bot Desktop") the agent may run for its computer-use tool. */
  stopOwnScreen: (botId: string) => req<{ engine: EngineInfo }>('POST', `/bots/${botId}/engine/screen/stop`),

  policies: () => req<{ policies: { tool: string; mode: string }[] }>('GET', '/policies'),
  deletePolicy: (tool: string) => req<{ ok: true }>('DELETE', `/policies/${encodeURIComponent(tool)}`),

  connectedApps: () => req<{ connectedApps?: Toolkit[]; connected: string[] }>('GET', '/apps?limit=1'),
  logout: () => req<{ ok: true }>('POST', '/auth/logout'),
};
