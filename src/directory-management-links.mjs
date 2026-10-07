// Links never transfer tokens or grant app roles. Each app verifies its own session.
export const GOURMET_USERS_URL =
  "https://marugo-s.github.io/gourmet/?view=users";
export const gourmetManagementUrl = (appId) =>
  appId === "gourmet" ? GOURMET_USERS_URL : null;
