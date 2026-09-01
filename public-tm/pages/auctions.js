import { startAuctionsView, stopAuctionsView } from "../auctions-view.js?v=18";

export async function start() {
  window.addEventListener("pagehide", () => stopAuctionsView());
  try {
    await startAuctionsView();
  } catch (err) {
    const meta = document.getElementById("auctions-meta");
    if (meta) meta.textContent = `Ошибка: ${err.message}`;
  }
}
