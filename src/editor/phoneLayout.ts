// The editor on a phone.
//
// The desktop editor is four panes side by side — library, canvas, code and
// inspector — which on a 390-pixel screen left the canvas no room at all. On a
// phone the editor shows one pane at a time, full size, with a tab bar at the
// bottom to move between them, the way phone apps are laid out.

import { useEffect, useState } from 'react';
import { create } from 'zustand';

/** Narrower than this, the editor uses the one-pane layout. */
export const PHONE_QUERY = '(max-width: 760px)';

export type PhonePane = 'circuit' | 'parts' | 'code' | 'inspect';

interface PhoneLayoutState {
  pane: PhonePane;
  setPane: (pane: PhonePane) => void;
}

export const usePhoneLayout = create<PhoneLayoutState>((set) => ({
  pane: 'circuit',
  setPane: (pane) => set({ pane }),
}));

function matches(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(PHONE_QUERY).matches;
}

/** Whether the screen is phone-sized, following rotation and resizes. */
export function useIsPhone(): boolean {
  const [phone, setPhone] = useState(matches);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(PHONE_QUERY);
    const update = () => setPhone(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return phone;
}

/** The same answer outside React, for event handlers. */
export const isPhone = matches;
