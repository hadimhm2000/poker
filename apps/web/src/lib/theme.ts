export const THEME_COOKIE = "theme";
export const THEMES = ["system", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];
export const isTheme = (v: unknown): v is Theme => THEMES.includes(v as Theme);
