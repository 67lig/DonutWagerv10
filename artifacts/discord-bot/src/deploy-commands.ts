/**
 * Run with: pnpm --filter @workspace/discord-bot run deploy-commands
 *
 * Pass --clear to wipe global commands (use this when the bot handles
 * guild-level registration itself and you want to remove any stale globals).
 */
import { REST, Routes } from "discord.js";

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;

if (!TOKEN || !CLIENT_ID) {
  console.error("Missing DISCORD_BOT_TOKEN or DISCORD_CLIENT_ID");
  process.exit(1);
}

const rest = new REST({ version: "10" }).setToken(TOKEN);
const clearing = process.argv.includes("--clear");

if (clearing) {
  console.log("Clearing all global slash commands…");
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: [] });
  console.log("Done — global commands cleared.");
} else {
  const { commands } = await import("./commands/index.js");
  const body = commands.map((c) => c.data.toJSON());
  console.log(`Registering ${body.length} commands globally…`);
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body });
  console.log("Done — all commands registered globally.");
}
