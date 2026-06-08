import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Message,
} from "discord.js";
import { adjustBalance, getOrCreateUser, recordGame } from "../lib/db.js";
import { formatCoins, MAX_BET, parseBet } from "../lib/format.js";
import { antiSpam } from "../lib/guards.js";
import { logGamble } from "../lib/gamblelog.js";
import { checkRig } from "../lib/rig.js";
import type { SlashCommand } from "../lib/types.js";
import { endSession, getSession, startSession } from "../games/sessions.js";

import { getHouseRates, riggingBiasFor, shouldHouseWin, type HouseRates } from "../lib/houserates.js";

// ── Cards ────────────────────────────────────────────────────────────────────
type Suit = "♠" | "♥" | "♦" | "♣";
type Rank = "A" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "10" | "J" | "Q" | "K";

interface Card { rank: Rank; suit: Suit }

const RANKS: Rank[] = ["A","2","3","4","5","6","7","8","9","10","J","Q","K"];
const SUITS: Suit[] = ["♠","♥","♦","♣"];

function buildDeck(): Card[] {
  const cards: Card[] = [];
  for (const s of SUITS) for (const r of RANKS) cards.push({ rank: r, suit: s });
  for (let i = cards.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [cards[i], cards[j]] = [cards[j]!, cards[i]!];
  }
  return cards;
}

function cardValue(rank: Rank): number {
  if (rank === "A") return 11;
  if (["K","Q","J","10"].includes(rank)) return 10;
  return parseInt(rank, 10);
}

function handTotal(hand: Card[]): number {
  let total = 0, aces = 0;
  for (const c of hand) {
    total += cardValue(c.rank);
    if (c.rank === "A") aces++;
  }
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return total;
}

function renderCard(c: Card): string { return `\`${c.rank}${c.suit}\``; }

function renderHand(hand: Card[], hideSecond = false): string {
  if (hideSecond && hand.length >= 2) return `${renderCard(hand[0]!)}  \`??\``;
  return hand.map(renderCard).join("  ");
}

// ── State ────────────────────────────────────────────────────────────────────
interface BJState {
  bet: bigint;
  deck: Card[];
  player: Card[];
  dealer: Card[];
  finished: boolean;
  willHouseWin: boolean;
  rig: number;
  rates: HouseRates;
}

function drawBiased(state: BJState, forPlayer: boolean): Card {
  if (state.rig <= 0 || Math.random() >= state.rig || state.deck.length < 5) {
    return state.deck.pop()!;
  }
  const playerTotal = handTotal(state.player);
  const dealerTotal = handTotal(state.dealer);
  const wantBust = state.willHouseWin && forPlayer;
  const wantHelpDealer = state.willHouseWin && !forPlayer;
  const wantHelpPlayer = !state.willHouseWin && forPlayer;
  const wantBustDealer = !state.willHouseWin && !forPlayer;

  const sorted = [...state.deck].sort((a, b) => {
    const av = cardValue(a.rank), bv = cardValue(b.rank);
    if (wantBust) {
      const aBusts = playerTotal + av > 21, bBusts = playerTotal + bv > 21;
      if (aBusts !== bBusts) return aBusts ? -1 : 1;
      return bv - av;
    }
    if (wantHelpDealer) {
      const aGood = dealerTotal + av >= 17 && dealerTotal + av <= 21;
      const bGood = dealerTotal + bv >= 17 && dealerTotal + bv <= 21;
      if (aGood !== bGood) return aGood ? -1 : 1;
      return Math.abs(20 - (dealerTotal + av)) - Math.abs(20 - (dealerTotal + bv));
    }
    if (wantHelpPlayer) {
      const aGood = playerTotal + av <= 21, bGood = playerTotal + bv <= 21;
      if (aGood !== bGood) return aGood ? -1 : 1;
      return Math.abs(20 - (playerTotal + av)) - Math.abs(20 - (playerTotal + bv));
    }
    if (wantBustDealer) {
      const aBusts = dealerTotal + av > 21, bBusts = dealerTotal + bv > 21;
      if (aBusts !== bBusts) return aBusts ? -1 : 1;
      return bv - av;
    }
    return 0;
  });

  const choice = sorted[0]!;
  state.deck = state.deck.filter(c => c !== choice);
  return choice;
}

// ── UI helpers ───────────────────────────────────────────────────────────────
function buildEmbed(state: BJState, status: string, hideDealer: boolean) {
  const playerTotal = handTotal(state.player);
  const dealerShown = hideDealer
    ? cardValue(state.dealer[0]!.rank)
    : handTotal(state.dealer);
  return new EmbedBuilder()
    .setColor(0x166534)
    .setTitle("🃏 Blackjack")
    .setDescription(status)
    .addFields(
      { name: `Dealer ${hideDealer ? "" : `(${dealerShown})`}`, value: renderHand(state.dealer, hideDealer) },
      { name: `You (${playerTotal})`, value: renderHand(state.player) },
      { name: "Bet", value: formatCoins(state.bet), inline: true },
    );
}

function controls(disabled: boolean) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("bj:hit").setLabel("Hit").setStyle(ButtonStyle.Primary).setDisabled(disabled),
    new ButtonBuilder().setCustomId("bj:stand").setLabel("Stand").setStyle(ButtonStyle.Secondary).setDisabled(disabled),
  );
}

// ── Command ──────────────────────────────────────────────────────────────────
const command: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("blackjack")
    .setDescription("Play a hand of blackjack against the dealer")
    .addStringOption(o => o.setName("bet").setDescription("Amount to bet").setRequired(true)),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    // ── Fast synchronous guards (must happen before defer) ──────────────────
    if (!antiSpam(interaction.user.id)) {
      await interaction.reply({ content: "Slow down.", flags: MessageFlags.Ephemeral });
      return;
    }
    if (getSession(interaction.user.id)) {
      await interaction.reply({ content: "Finish your active game first.", flags: MessageFlags.Ephemeral });
      return;
    }

    // ── Defer immediately before any DB/async work ──────────────────────────
    await interaction.deferReply();

    // ── DB lookups ──────────────────────────────────────────────────────────
    const user = await getOrCreateUser(interaction.user.id);

    if (!user.verified) {
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xff5555)
            .setTitle("Verification Required")
            .setDescription("You must verify your account before gambling.\nUse `/verify minecraft:<your_username>` to begin."),
        ],
      });
      return;
    }

    const balance = BigInt(user.balance);
    const rawBet = interaction.options.getString("bet", true);
    const betParsed = parseBet(rawBet, balance);

    if (!betParsed || betParsed <= 0n) {
      await interaction.editReply({ content: "Invalid bet. Try a number, `all`, `half`, or values like `100k`, `5mil`, `1bil`." });
      return;
    }
    if (betParsed < 10_000n) {
      await interaction.editReply({ content: "Minimum bet is **10,000 coins** (10k)." });
      return;
    }
    if (betParsed > MAX_BET) {
      await interaction.editReply({ content: `Maximum bet is **150,000,000 coins** (150M).` });
      return;
    }
    if (betParsed > balance) {
      await interaction.editReply({ content: `Not enough coins. Your balance is ${formatCoins(balance)}.` });
      return;
    }

    const bet = betParsed;

    // ── Start session & deduct bet ──────────────────────────────────────────
    if (!startSession(interaction.user.id, "blackjack")) {
      await interaction.editReply({ content: "Finish your active game first." });
      return;
    }
    const bjSession = getSession(interaction.user.id)!;
    await adjustBalance(interaction.user.id, -bet);

    // ── Deal ────────────────────────────────────────────────────────────────
    const deck = buildDeck();
    const rigResult = await checkRig(interaction.user.id, bjSession.startedAt);
    const rates = await getHouseRates();
    const state: BJState = {
      bet,
      deck,
      player: [],
      dealer: [],
      finished: false,
      willHouseWin: rigResult.active && rigResult.forceLoss
        ? true
        : rigResult.active && rigResult.forceWin
          ? false
          : shouldHouseWin(rates, bet),
      rig: rigResult.active ? 1.0 : riggingBiasFor(rates, bet),
      rates,
    };
    state.player.push(drawBiased(state, true));
    state.dealer.push(drawBiased(state, false));
    state.player.push(drawBiased(state, true));
    state.dealer.push(drawBiased(state, false));

    const playerTotal = handTotal(state.player);
    const dealerTotal = handTotal(state.dealer);
    const isPlayerBJ = playerTotal === 21;
    const isDealerBJ = dealerTotal === 21;

    // ── Instant blackjack ───────────────────────────────────────────────────
    if (isPlayerBJ || isDealerBJ) {
      try {
        let payout = 0n;
        let label: string;
        if (isPlayerBJ && !isDealerBJ) {
          // 3:2 payout — player gets back their bet plus 1.5× their bet
          payout = (bet * 5n) / 2n;
          label = `**Blackjack! You won ${formatCoins(payout - bet)}.**`;
          await adjustBalance(interaction.user.id, payout);
        } else if (!isPlayerBJ && isDealerBJ) {
          label = `**Dealer blackjack. You lost ${formatCoins(bet)}.**`;
        } else {
          payout = bet;
          label = "**Push.** Both have blackjack.";
          await adjustBalance(interaction.user.id, payout);
        }
        await recordGame({
          discordId: interaction.user.id, game: "blackjack", bet, payout,
          won: payout > bet,
          details: { instantBJ: true, playerBJ: isPlayerBJ, dealerBJ: isDealerBJ },
        });
        await logGamble({
          discordId: interaction.user.id, game: "blackjack", bet, payout,
          won: payout > bet,
          detail: isPlayerBJ && isDealerBJ ? "push BJ" : isPlayerBJ ? "natural BJ 3:2" : "dealer BJ",
        });
        await interaction.editReply({
          embeds: [
            buildEmbed(state, label, false).setColor(
              payout > bet ? 0x22c55e : payout === bet ? 0xfacc15 : 0xef4444,
            ),
          ],
          components: [controls(true)],
        });
      } finally {
        endSession(interaction.user.id);
      }
      return;
    }

    // ── Show initial board ───────────────────────────────────────────────────
    await interaction.editReply({
      embeds: [buildEmbed(state, "Hit or Stand.", true)],
      components: [controls(false)],
    });

    const message = await interaction.fetchReply() as Message;

    // ── Collector ────────────────────────────────────────────────────────────
    let collectorStopped = false;

    const collector = message.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: 5 * 60 * 1000,
      filter: i => i.user.id === interaction.user.id,
    });

    const finishHand = async (btn: ButtonInteraction | null): Promise<void> => {
      try {
        // Dealer plays — stands on all 17s
        while (handTotal(state.dealer) < 17) {
          state.dealer.push(drawBiased(state, false));
        }
        const pTotal = handTotal(state.player);
        const dTotal = handTotal(state.dealer);

        let result: "win" | "lose" | "push";
        let payout = 0n;
        if (pTotal > 21) {
          result = "lose";
        } else if (dTotal > 21 || pTotal > dTotal) {
          result = "win";
          payout = bet * 2n;
        } else if (pTotal === dTotal) {
          result = "push";
          payout = bet;
        } else {
          result = "lose";
        }

        if (payout > 0n) await adjustBalance(interaction.user.id, payout);
        await recordGame({
          discordId: interaction.user.id, game: "blackjack", bet, payout,
          won: result === "win",
          details: { result, pTotal, dTotal },
        });
        await logGamble({
          discordId: interaction.user.id, game: "blackjack", bet, payout,
          won: result === "win",
          detail: `player:${pTotal} dealer:${dTotal} ${result}`,
        });

        const msg =
          result === "win" ? `**You won ${formatCoins(payout - bet)}!**` :
          result === "push" ? `**Push.** Bet returned.` :
          `**You lost ${formatCoins(bet)}.**`;

        const finalEmbed = buildEmbed(state, msg, false).setColor(
          result === "win" ? 0x22c55e : result === "push" ? 0xfacc15 : 0xef4444,
        );
        const payload = { embeds: [finalEmbed], components: [controls(true)] };
        try {
          if (btn) await btn.update(payload);
          else await message.edit(payload);
        } catch { /* ignore Discord errors updating the message */ }
      } finally {
        endSession(interaction.user.id);
        if (!collectorStopped) { collectorStopped = true; collector.stop("done"); }
      }
    };

    collector.on("collect", async (btn: ButtonInteraction) => {
      if (state.finished) { await btn.deferUpdate().catch(() => {}); return; }

      if (btn.customId === "bj:hit") {
        state.player.push(drawBiased(state, true));
        if (handTotal(state.player) > 21) {
          state.finished = true;
          await finishHand(btn);
        } else {
          await btn.update({
            embeds: [buildEmbed(state, "Hit or Stand.", true)],
            components: [controls(false)],
          });
        }
      } else if (btn.customId === "bj:stand") {
        state.finished = true;
        await finishHand(btn);
      }
    });

    collector.on("end", async (_c, reason) => {
      if (reason === "done") return;
      if (state.finished) return;
      // Timed out — refund bet
      try { await adjustBalance(interaction.user.id, bet); } catch { /* best effort */ }
      endSession(interaction.user.id);
      try {
        await message.edit({
          embeds: [buildEmbed(state, "Timed out. Bet refunded.", false)],
          components: [controls(true)],
        });
      } catch { /* ignore */ }
    });
  },
};

export default command;
