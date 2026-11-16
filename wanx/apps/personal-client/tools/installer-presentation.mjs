// Finder uses logical points. dmg-builder combines the base PNG and its @2x
// sibling into a Retina TIFF; the base image must match this window size.
export const MAC_DMG_LAYOUT = Object.freeze({
  width: 760,
  height: 480,
  iconSize: 96,
  iconTextSize: 13,
  appX: 204,
  applicationsX: 556,
  iconY: 270,
});

export const MAC_DMG_COPY = Object.freeze({
  heading: "把记忆盒子放进应用程序",
  instruction: "拖入后，请从“应用程序”打开。",
});

export function macDmgPresentation({ appName, background } = {}) {
  if (typeof appName !== "string" || !appName.trim()) throw new TypeError("MAC_DMG_APP_NAME_REQUIRED");
  if (typeof background !== "string" || !background.trim() || /@\dx\.[^/\\.]+$/i.test(background))
    throw new TypeError("MAC_DMG_BASE_BACKGROUND_REQUIRED");
  const { width, height, iconSize, iconTextSize, appX, applicationsX, iconY } = MAC_DMG_LAYOUT;
  return {
    title: appName,
    background,
    window: { width, height },
    iconSize,
    iconTextSize,
    contents: [
      // Omitting path/name lets dmg-builder use the actual built .app, including
      // an isolated test bundle's identity. No application is renamed here.
      { x: appX, y: iconY, type: "file" },
      { x: applicationsX, y: iconY, type: "link", path: "/Applications" },
    ],
  };
}
