import type { SlashCommand } from "../lib/types.js";
import verify from "./verify.js";
import invites from "./invites.js";
import balance from "./balance.js";
import daily from "./daily.js";
import close from "./close.js";
import reset from "./reset.js";
import redeem from "./redeem.js";
import help from "./help.js";
import coinflip from "./coinflip.js";
import dice from "./dice.js";
import roulette from "./roulette.js";
import blackjack from "./blackjack.js";
import mines from "./mines.js";
import towers from "./towers.js";
import provablyfair from "./provablyfair.js";
import resethash from "./resethash.js";
import adminpanel from "./adminpanel.js";
import serverpanel from "./serverpanel.js";
import userpanel from "./userpanel.js";
import forceverify from "./forceverify.js";
import setbalance from "./setbalance.js";
import withdrawCmd from "./withdraw_cmd.js";
import depositCmd from "./deposit_cmd.js";
import pay from "./pay.js";

export const commands: SlashCommand[] = [
  verify,
  adminpanel,
  serverpanel,
  pay,
  userpanel,
  invites,
  balance,
  daily,
  close,
  reset,
  redeem,
  help,
  coinflip,
  dice,
  roulette,
  blackjack,
  mines,
  towers,
  provablyfair,
  resethash,
  forceverify,
  setbalance,
  withdrawCmd,
  depositCmd,
];

export const commandMap: Map<string, SlashCommand> = new Map(
  commands.map((c) => [c.data.name, c]),
);
