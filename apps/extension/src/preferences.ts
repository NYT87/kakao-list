import { useEffect, useState } from "react";

const DEBUG_STORAGE_KEY = "kakao-lists:extension-debug";
const SKIP_OWNER_VALIDATION_STORAGE_KEY =
  "kakao-lists:extension-skip-owner-validation";
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

export function readSkipOwnerValidation(): boolean {
  return readBooleanPreference(SKIP_OWNER_VALIDATION_STORAGE_KEY, false);
}

export function writeSkipOwnerValidation(enabled: boolean) {
  writeBooleanPreference(SKIP_OWNER_VALIDATION_STORAGE_KEY, enabled);
}

export function useSkipOwnerValidation(): [
  boolean,
  (enabled: boolean) => void,
] {
  return useBooleanPreference(
    readSkipOwnerValidation,
    writeSkipOwnerValidation,
  );
}

function readBooleanPreference(key: string, fallback: boolean) {
  const raw = window.localStorage.getItem(key);
  if (raw === "true") {
    return true;
  }

  if (raw === "false") {
    return false;
  }

  return fallback;
}

function writeBooleanPreference(key: string, enabled: boolean) {
  window.localStorage.setItem(key, String(enabled));
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
