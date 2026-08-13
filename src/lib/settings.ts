// Small on-device settings persisted in db.meta (DESIGN.md §4.4/§6 M5: the live
// Lichess Explorer lookup). The app is public on GitHub Pages, so no API token can
// ever ship in the bundle — this is a per-device value the user pastes in once (Home's
// "Settings" section), read by src/screens/Explorer.tsx to gate the live lookup.
// Never logged; never sent anywhere except explorer.lichess.ovh as an Authorization
// header (see src/screens/Explorer.tsx).

import { db } from "./db";

const LICHESS_TOKEN_KEY = "lichessToken";

export async function getLichessToken(): Promise<string | null> {
  const row = await db.meta.get(LICHESS_TOKEN_KEY);
  const value = row?.value;
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** Empty/whitespace-only input clears the stored token. */
export async function setLichessToken(token: string): Promise<void> {
  const trimmed = token.trim();
  if (trimmed === "") {
    await db.meta.delete(LICHESS_TOKEN_KEY);
    return;
  }
  await db.meta.put({ key: LICHESS_TOKEN_KEY, value: trimmed });
}
