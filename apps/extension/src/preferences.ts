import { browserStorage } from "@kakao-lists/storage";
import { useEffect, useState } from "react";

const DEBUG_STORAGE_KEY = "kakao-lists:extension-debug";
const PREFERENCE_CHANGE_EVENT = "kakao-lists:preference-change";

export function readDebugMode(): boolean {
  return readBooleanPreference(DEBUG_STORAGE_KEY, __DEBUG_MODE__);
}

export function writeDebugMode(enabled: boolean) {
  writeBooleanPreference(DEBUG_STORAGE_KEY, enabled);
}

export function useDebugMode(): [boolean, (enabled: boolean) => void] {
  return useBooleanPreference(readDebugMode, writeDebugMode);
}

function readBooleanPreference(key: string, fallback: boolean) {
  const raw = browserStorage().getItem(key);
  if (raw === "true") {
    return true;
  }

  if (raw === "false") {
    return false;
  }

  return fallback;
}

function writeBooleanPreference(key: string, enabled: boolean) {
  browserStorage().setItem(key, String(enabled));
  window.dispatchEvent(new CustomEvent(PREFERENCE_CHANGE_EVENT));
}

function useBooleanPreference(
  read: () => boolean,
  write: (enabled: boolean) => void,
): [boolean, (enabled: boolean) => void] {
  const [enabled, setEnabled] = useState(read);

  useEffect(() => {
    const onChange = () => setEnabled(read());
    window.addEventListener(PREFERENCE_CHANGE_EVENT, onChange);
    window.addEventListener("storage", onChange);

    return () => {
      window.removeEventListener(PREFERENCE_CHANGE_EVENT, onChange);
      window.removeEventListener("storage", onChange);
    };
  }, [read]);

  const update = (next: boolean) => {
    write(next);
    setEnabled(next);
  };

  return [enabled, update];
}
