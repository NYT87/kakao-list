export type ThemePreference = "system" | "light" | "dark";

const THEME_STORAGE_KEY = "kakao-lists:extension-theme";
const THEME_MEDIA_QUERY = "(prefers-color-scheme: dark)";

export function readThemePreference(): ThemePreference {
  const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
  return raw === "light" || raw === "dark" || raw === "system" ? raw : "system";
}

export function writeThemePreference(preference: ThemePreference) {
  window.localStorage.setItem(THEME_STORAGE_KEY, preference);
  applyThemePreference(preference);
}

export function applyThemePreference(preference: ThemePreference) {
  const resolved = resolveTheme(preference);
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
}

export function initializeTheme() {
  applyThemePreference(readThemePreference());

  const media = window.matchMedia(THEME_MEDIA_QUERY);
  const onChange = () => {
    if (readThemePreference() === "system") {
      applyThemePreference("system");
    }
  };

  media.addEventListener("change", onChange);
}

function resolveTheme(preference: ThemePreference) {
  if (preference !== "system") {
    return preference;
  }

  return window.matchMedia(THEME_MEDIA_QUERY).matches ? "dark" : "light";
}
