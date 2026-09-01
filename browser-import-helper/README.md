# Mantra Sorare Browser Import

Load-unpacked Chrome helper for importing projection ribbons already rendered on
`sorare.com` by Sorare Inside Companion v0.3.0.

It reads only visible, ready `.si-companion-ribbon` and
`.si-companion-detail-ribbon` data attributes. It never reads cookies, browser
storage, Companion tokens, passwords, network responses, or private APIs.

## Load in Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this `browser-import-helper` directory.
5. Confirm extension ID `daolkoaipaheaaolpgnccddnipadlbnc`.

Keep Sorare Inside Companion installed separately. Generate a one-time code in
the Mantra account dialog, open a Sorare page where Companion ribbons are
visible, paste the code into the **Mantra browser import** panel, and click
**Import visible projections**.

The helper has no cookie or storage permission. Its only host access is
`sorare.com` and `mantra.panenka.games`.
