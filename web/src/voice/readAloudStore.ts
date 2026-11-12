import { create } from 'zustand';
import { LocalReadAloud, type ReadAloudState } from './readAloud';
import { createLocalReadAloudAudio } from './localReadAloudAudio';
import { bindLocalReadAloud, readAloudSnapshot } from './readAloudBinding';

export const useReadAloud = create<ReadAloudState>(() => ({ enabled: false, status: 'off', error: null }));
const controller = new LocalReadAloud(createLocalReadAloudAudio(), (state) => useReadAloud.setState(state));
export const connectLocalReadAloud = () => bindLocalReadAloud(controller);

/** Keep this synchronous wrapper directly in the button's click handler. */
export function toggleLocalReadAloud() {
  if (controller.enabled || useReadAloud.getState().status === 'enabling') controller.disable();
  else void controller.enable(readAloudSnapshot(), 'Local voice is ready. New replies will be read aloud.');
}

export function cancelReadAloud() { controller.cancel(); }
export function disableReadAloud() { controller.disable(); }
