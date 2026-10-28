import { createContext, useContext } from 'react';

// a right-bar module shown in the side panel, or as a full page in a tool tab
// (no full-screen / close buttons there)
export const PanelModeContext = createContext<'panel' | 'page'>('panel');
export const usePanelMode = () => useContext(PanelModeContext);
