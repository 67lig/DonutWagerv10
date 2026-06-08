import {
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import {
  createCoupon,
  deleteCoupon,
  listCoupons,
} from "../lib/db.js";
import { formatCoins, parseAmount } from "../lib/format.js";
import { logAdminAction } from "../lib/gamblelog.js";
import { isOwner } from "../lib/permissions.js";
import type { SlashCommand } from "../lib/types.js";

const CODE_REGEX = /^[A-Z0-9_-]{3,32}$/i;

const command: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("coupon")
    .setDescription("Admin-only: manage redeemable coupon codes")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sc) =>
      sc
        .setName("create")
        .setDescription("Mint a new coupon code")
        .addStringOption((o) =>
          o
            .setName("code")
            .setDescription("The code players will redeem (3-32 chars)")
            .setRequired(true)
            .setMinLength(3)
            .setMaxLength(32),
        )
        .addStringOption((o) =>
          o
            .setName("amount")
            .setDescription("Coins per redemption (e.g. 10k, 1mil, 5mil)")
            .setRequired(true),
        )
        .addIntegerOption((o) =>
          o
            .setName("max_uses")
            .setDescription("How many users can redeem this code in total")
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(1_000_000),
        )
        .addStringOption((o) =>
          o
            .setName("type")
            .setDescription("gamble = must gamble before withdraw | nongamble = free to withdraw")
            .setRequired(true)
            .addChoices(
              { name: "gamble — must gamble before withdraw", value: "gamble" },
              { name: "nongamble — withdraw freely", value: "nongamble" },
            ),
        )
        .addIntegerOption((o) =>
          o
            .setName("expires_in_hours")
            .setDescription("Hours until the code expires (omit for never)")
            .setRequired(false)
            .setMinValue(1)
            .setMaxValue(24 * 365),
        ),
    )
    .addSubcommand((sc) =>
      sc.setName("list").setDescription("List active coupon codes"),
    )
    .addSubcommand((sc) =>
      sc
        .setName("delete")
        .setDescription("Delete a coupon code")
        .addStringOption((o) =>
          o.setName("code").setDescription("Code to delete").setRequired(true),
        ),
    ),
  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!isOwner(interaction)) {
      await interaction.reply({
        content: "Bot owner only.",
        ephemeral: true,
      });
      return;
    }
    const sub = interaction.options.getSubcommand(true);

    if (sub === "create") {
      const rawCode = interaction.options.getString("code", true).trim();
      const code = rawCode.toUpperCase();
      if (!CODE_REGEX.test(code)) {
        await interaction.reply({
          content:
            "Invalid code. Use 3-32 characters: letters, numbers, dashes, underscores.",
          ephemeral: true,
        });
        return;
      }
      const rawAmount = interaction.options.getString("amount", true);
      const amount = parseAmount(rawAmount);
      if (amount === null || amount <= 0n) {
        await interaction.reply({
          content:
            "Invalid amount. Try formats like `10k`, `100k`, `1mil`, `5mil`.",
          ephemeral: true,
        });
        return;
      }
      const maxUses = interaction.options.getInteger("max_uses", true);
      const couponType = interaction.options.getString("type", true) as "gamble" | "nongamble";
      const hours = interaction.options.getInteger("expires_in_hours");
      const expiresAt = hours ? new Date(Date.now() + hours * 3600 * 1000) : null;

      const coupon = await createCoupon({
        code,
        amount,
        maxUses,
        expiresAt,
        createdBy: interaction.user.id,
        couponType,
      });
      if (!coupon) {
        await interaction.reply({
          content: `A coupon with code \`${code}\` already exists.`,
          ephemeral: true,
        });
        return;
      }

      const expiresLine = coupon.expires_at
        ? `<t:${Math.floor(new Date(coupon.expires_at).getTime() / 1000)}:R>`
        : "Never";

      const requirementLabel = coupon.coupon_type === "gamble"
        ? "Must gamble before withdraw"
        : "No gamble required";

      await logAdminAction({
        actorId: interaction.user.id,
        actorTag: interaction.user.tag,
        action: "Coupon Created",
        amount: BigInt(coupon.amount),
        detail:
          `Code: \`${coupon.code}\` · Type: ${coupon.coupon_type} · Max uses: ${coupon.max_uses}` +
          (coupon.expires_at
            ? ` · Expires: <t:${Math.floor(new Date(coupon.expires_at).getTime() / 1000)}:R>`
            : " · No expiry") +
          ` · Total liability: ${formatCoins(BigInt(coupon.amount) * BigInt(coupon.max_uses))}`,
      });

      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x22c55e)
            .setTitle("New Promo Code")
            .setDescription(
              "Use this code on the website to claim your reward!",
            )
            .addFields(
              { name: "Code", value: `\`${coupon.code}\``, inline: true },
              {
                name: "Amount",
                value: formatCoins(BigInt(coupon.amount)),
                inline: true,
              },
              {
                name: "Requirement",
                value: requirementLabel,
                inline: true,
              },
              {
                name: "Uses",
                value: `${coupon.max_uses.toLocaleString()} redemptions`,
                inline: true,
              },
              {
                name: "Expires",
                value: expiresLine,
                inline: true,
              },
              {
                name: "How to redeem (step-by-step)",
                value:
                  `1. Go to the casino bot here in Discord.\n` +
                  `2. Run \`/redeem code:${coupon.code}\`.\n` +
                  `3. Coins are credited to your balance instantly.`,
              },
            )
            .setFooter({
              text: `Total liability: ${formatCoins(BigInt(coupon.amount) * BigInt(coupon.max_uses))}`,
            }),
        ],
      });
      return;
    }

    if (sub === "list") {
      const all = await listCoupons();
      if (all.length === 0) {
        await interaction.reply({
          content: "No coupons exist yet. Use `/coupon create` to mint one.",
          ephemeral: true,
        });
        return;
      }
      const now = Date.now();
      const lines = all.map((c) => {
        const expired = c.expires_at && new Date(c.expires_at).getTime() < now;
        const exhausted = c.uses_count >= c.max_uses;
        const status = expired
          ? "expired"
          : exhausted
            ? "exhausted"
            : "✅ active";
        const expires = c.expires_at
          ? ` · expires <t:${Math.floor(new Date(c.expires_at).getTime() / 1000)}:R>`
          : "";
        const typeTag = c.coupon_type === "nongamble" ? " · ✅ free" : " · 🎲 gamble";
        return `\`${c.code}\` — ${formatCoins(BigInt(c.amount))} · ${c.uses_count}/${c.max_uses} used · ${status}${typeTag}${expires}`;
      });
      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x8b5cf6)
            .setTitle("Coupons")
            .setDescription(lines.join("\n").slice(0, 4000)),
        ],
        ephemeral: true,
      });
      return;
    }

    if (sub === "delete") {
      const code = interaction.options.getString("code", true).trim().toUpperCase();
      const ok = await deleteCoupon(code);
      if (ok) {
        await logAdminAction({
          actorId: interaction.user.id,
          actorTag: interaction.user.tag,
          action: "Coupon Deleted",
          detail: `Code: \`${code}\``,
          good: false,
        });
      }
      await interaction.reply({
        content: ok
          ? `Deleted coupon \`${code}\`.`
          : `No coupon with code \`${code}\` found.`,
        ephemeral: true,
      });
      return;
    }
  },
};

export default command;
