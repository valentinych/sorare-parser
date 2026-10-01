import { fetchMantraManagerHtml, mantraCredentialsConfigured } from "../clients/mantraAuth.js";
import { getDb } from "../db/index.js";
import { parseManagerNicknameHtml, syncManagerNicknames } from "../domain/mantraManagers.js";

async function fetchNickname(id: number): Promise<string | null> {
  const html = await fetchMantraManagerHtml(id);
  return parseManagerNicknameHtml(html);
}

/** Fill sqlite nicknames from signed-in `/managers/{id}`. Not used by GET. */
export async function syncMantraManagerNicknames(opts?: {
  limit?: number;
  force?: boolean;
  ids?: number[];
}): Promise<number> {
  if (!mantraCredentialsConfigured()) {
    console.log("mantra nicknames skipped (MANTRA_EMAIL/PASSWORD unset)");
    return 0;
  }
  const database = getDb();
  const n = await syncManagerNicknames({
    database,
    fetchNickname,
    limit: opts?.limit,
    force: opts?.force,
    ids: opts?.ids,
  });
  console.log(`mantra nicknames synced: ${n}`);
  return n;
}
