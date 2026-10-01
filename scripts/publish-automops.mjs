#!/usr/bin/env node
/**
 * Publish tour predicts to Telegram @automops via @draftmantra_bot.
 *
 * Setup:
 * 1) Channel https://t.me/automops → Manage → Administrators → Add
 * 2) @draftmantra_bot + "Post Messages"
 * 3) Manage → Discussion → link a group; add the bot as group admin
 * 4) npm run publish:automops -- --league=135 --tour=4 --upcoming
 * 5) Comments only:
 *    npm run publish:automops -- --league=135 --tour=4 --upcoming --comments-only --reply-to=2
 *
 * Env: DRAFTMANTRA_BOT_TOKEN, AUTOMOPS_CHANNEL_ID=@automops
 */
import { runAutomopsCli } from "../src/domain/automopsPublish.mjs";

runAutomopsCli().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
