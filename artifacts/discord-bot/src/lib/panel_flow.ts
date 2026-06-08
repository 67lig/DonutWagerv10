import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ModalSubmitInteraction,
  type TextChannel,
} from "discord.js";
import {
  adjustBalance,
  completePendingDeposit,
  createPendingDeposit,
  createPendingWithdrawal,
  findUserByMinecraftUsername,
  getPendingDepositById,
  getOrCreateUser,
  recordBalanceEvent,
} from "./db.js";
import { formatCoins, parseAmount } from "./format.js";
import { createTicketChannel } from "./tickets.js";
import {
  buildWithdrawComponents,
  buildWithdrawEmbed,
} from "./withdraw_flow.js";
import { isMod } from "./permissions.js";
import { logAdminAction } from "./gamblelog.js";
import { DEPOSIT_LOG_CHANNEL_IDS } from "./config.js";
import { JAVA_IGN_REGEX as JAVA_REGEX, lookupJavaProfile as lookupMinecraftProfile } from "./mojang.js";

export const PANEL_BTN_PREFIX = "panel";
export const PANEL_MODAL_PREFIX = "panel_modal";
export const DEP_TICKET_BTN_PREFIX = "dep_ticket";

const MIN_DEPOSIT = 1_000_000n;
const MIN_WITHDRAW = 1_000_000n;

export function buildPanelMessage(): {
  embed: EmbedBuilder;
  components: ActionRowBuilder<ButtonBuilder>[];
} {
  const embed = new EmbedBuilder()
    .setColor(0xf59e0b)
    .setTitle("DonutSMP Casino")
    .setDescription(
      [
        "**How to Play:**",
        "",
        "Click Settings to set your gambling username",
        "Click Deposit to open a deposit ticket",
        "Use slash commands to play games",
        "Click Withdraw to cash out",
        "",
        "**Games:**",
        "`/coinflip <bet> <heads/tails>`",
        "`/dice <bet> <target>` - Over target to win",
        "`/mines <bet> [mines]` - Avoid mines, cash out anytime",
        "`/blackjack <bet>` - Beat the dealer",
        "`/roulette <bet> <red/black/number>` - Spin the wheel",
        "",
        "**Limits:** 10k - 150M per bet",
        "Use `/balance` to check your wallet.",
        "Click a button below to get started.",
      ].join("\n"),
    );

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${PANEL_BTN_PREFIX}:settings`)
      .setLabel("Settings")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${PANEL_BTN_PREFIX}:deposit`)
      .setLabel("Deposit")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${PANEL_BTN_PREFIX}:withdraw`)
      .setLabel("Withdraw")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${PANEL_BTN_PREFIX}:balance`)
      .setLabel("Balance")
      .setStyle(ButtonStyle.Secondary),
  );

  return { embed, components: [row] };
}

function ignModal(platform: "java" | "bedrock"): ModalBuilder {
  const modal = new ModalBuilder()
    .setCustomId(`${PANEL_MODAL_PREFIX}:verify_${platform}`)
    .setTitle(
      platform === "java"
        ? "Verify - Java Edition"
        : "Verify - Bedrock Edition",
    );
  const input = new TextInputBuilder()
    .setCustomId("ign")
    .setLabel(
      platform === "java"
        ? "Java username (3-16 chars, e.g. Notch)"
        : "Bedrock gamertag (1-32 chars)",
    )
    .setPlaceholder(platform === "java" ? "Notch" : "YourGamertag")
    .setRequired(true)
    .setMinLength(platform === "java" ? 3 : 1)
    .setMaxLength(platform === "java" ? 16 : 32)
    .setStyle(TextInputStyle.Short);
  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(input),
  );
  return modal;
}

function amountModal(action: "deposit" | "withdraw"): ModalBuilder {
  const modal = new ModalBuilder()
    .setCustomId(`${PANEL_MODAL_PREFIX}:${action}`)
    .setTitle(action === "deposit" ? "Deposit" : "Withdraw");
  const input = new TextInputBuilder()
    .setCustomId("amount")
    .setLabel("Amount (e.g. 1mil, 10mil, 100mil, 1bil)")
    .setPlaceholder("10mil")
    .setRequired(true)
    .setMinLength(1)
    .setMaxLength(20)
    .setStyle(TextInputStyle.Short);
  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(input),
  );
  return modal;
}

export async function handlePanelButton(
  interaction: ButtonInteraction,
): Promise<void> {
  const action = interaction.customId.split(":")[1];
  if (!action) return;

  if (action === "balance") {
    const user = await getOrCreateUser(interaction.user.id);
    const balance = BigInt(user.balance);
    const wagerReq = BigInt(user.wager_requirement ?? "0");

    if (wagerReq > 0n) {
      const withdrawable = balance > wagerReq ? balance - wagerReq : 0n;
      const embed = new EmbedBuilder()
        .setColor(0xf59e0b)
        .setTitle("Your Balance")
        .addFields(
          { name: "Total Balance", value: formatCoins(balance), inline: true },
          { name: "Withdrawable", value: formatCoins(withdrawable), inline: true },
          { name: "Locked", value: `${formatCoins(wagerReq)}\n*Must gamble before withdraw*`, inline: true },
        )
        .setFooter({ text: interaction.user.tag })
        .setTimestamp();
      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    } else {
      const embed = new EmbedBuilder()
        .setColor(0x22c55e)
        .setTitle("Your Balance")
        .setDescription(formatCoins(balance))
        .setFooter({ text: interaction.user.tag })
        .setTimestamp();
      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }
    return;
  }

  if (action === "settings") {
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${PANEL_BTN_PREFIX}:verify_java`)
        .setLabel("Link Minecraft Account")
        .setStyle(ButtonStyle.Secondary),
    );
    const embed = new EmbedBuilder()
      .setColor(0x6b7280)
      .setTitle("Settings - Link Your Account")
      .setDescription(
        "Click below to link your Java Edition Minecraft account.\n" +
        "You need a verified account to deposit or withdraw.",
      );
    await interaction.reply({
      embeds: [embed],
      components: [row],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (action === "verify_java") {
    await interaction.showModal(ignModal("java"));
    return;
  }

  if (action === "deposit" || action === "withdraw") {
    const user = await getOrCreateUser(interaction.user.id);
    if (!user.verified || !user.minecraft_username) {
      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xef4444)
            .setTitle("Not Verified")
            .setDescription(
              "You need to link your Minecraft username first.\nClick **Settings** on the panel to get started.",
            ),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (action === "withdraw") {
      const balance = BigInt(user.balance);
      const wagerReq = BigInt(user.wager_requirement ?? "0");
      const withdrawable = balance > wagerReq ? balance - wagerReq : 0n;
      if (withdrawable <= 0n) {
        await interaction.reply({
          embeds: [
            new EmbedBuilder()
              .setColor(0xef4444)
              .setTitle("Balance Locked")
              .setDescription(
                "Your entire balance is locked behind a wagering requirement.\n" +
                "Keep playing to unlock it!",
              )
              .addFields(
                { name: "Total Balance", value: formatCoins(balance), inline: true },
                { name: "Locked", value: formatCoins(wagerReq), inline: true },
              ),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
    }
    await interaction.showModal(amountModal(action));
    return;
  }
}

export async function handleDepositTicketButton(
  interaction: ButtonInteraction,
): Promise<void> {
  const parts = interaction.customId.split(":");
  const action = parts[1];
  const pendingId = parts[2];
  const userId = parts[3];
  if (!action || !pendingId || !userId) return;

  if (!(await isMod(interaction))) {
    await interaction.reply({ content: "Staff only.", ephemeral: true });
    return;
  }

  const pending = await getPendingDepositById(pendingId);
  if (!pending || pending.status !== "pending" || pending.discord_id !== userId) {
    await interaction.reply({
      content: "This deposit ticket is no longer active or has already been processed.",
      ephemeral: true,
    });
    return;
  }

  const amount = BigInt(pending.amount);

  if (action === "accept") {
    try {
      await interaction.deferUpdate();
    } catch {
      return;
    }

    const completed = await completePendingDeposit(pendingId);
    if (!completed) {
      await interaction.followUp({ content: "Already processed.", ephemeral: true });
      return;
    }

    await getOrCreateUser(userId);
    const newBal = await adjustBalance(userId, amount);
    await recordBalanceEvent({
      discordId: userId,
      delta: amount,
      source: "deposit",
      detail: `Deposit accepted by ${interaction.user.tag}`,
    });
    await logAdminAction({
      actorId: interaction.user.id,
      actorTag: interaction.user.tag,
      action: "Deposit Accepted",
      targetId: userId,
      amount,
      detail: `New balance: ${formatCoins(newBal)}`,
    });

    const confirmEmbed = new EmbedBuilder()
      .setColor(0x22c55e)
      .setTitle("Deposit Accepted")
      .addFields(
        { name: "User", value: `<@${userId}>`, inline: true },
        { name: "Amount", value: formatCoins(amount), inline: true },
        { name: "New Balance", value: formatCoins(newBal), inline: true },
        { name: "Accepted by", value: `<@${interaction.user.id}>`, inline: true },
      )
      .setTimestamp();

    await interaction.editReply({ embeds: [confirmEmbed], components: [] });

    for (const channelId of DEPOSIT_LOG_CHANNEL_IDS) {
      try {
        const ch = await interaction.client.channels.fetch(channelId);
        if (ch?.isTextBased() && "send" in ch) {
          await (ch as { send: (o: unknown) => Promise<unknown> }).send({ embeds: [confirmEmbed] });
        }
      } catch { /* ignore */ }
    }
    return;
  }

  if (action === "deny") {
    try {
      await interaction.deferUpdate();
    } catch {
      return;
    }

    const cancelledOk = await completePendingDeposit(pendingId);
    if (!cancelledOk) {
      await interaction.followUp({ content: "Already processed.", ephemeral: true });
      return;
    }

    const denyEmbed = new EmbedBuilder()
      .setColor(0xef4444)
      .setTitle("Deposit Denied")
      .addFields(
        { name: "User", value: `<@${userId}>`, inline: true },
        { name: "Amount", value: formatCoins(amount), inline: true },
        { name: "Denied by", value: `<@${interaction.user.id}>`, inline: true },
      )
      .setTimestamp();

    await interaction.editReply({ embeds: [denyEmbed], components: [] });
    return;
  }
}

export async function handlePanelModal(
  interaction: ModalSubmitInteraction,
): Promise<void> {
  const action = interaction.customId.split(":")[1];
  if (!action) return;

  if (action === "verify_java") {
    const ign = interaction.fields.getTextInputValue("ign").trim();
    if (!JAVA_REGEX.test(ign)) {
      await interaction.reply({
        content:
          "Invalid Java username. Use 3-16 characters: letters, numbers, underscore only.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (!interaction.guild) {
      await interaction.reply({ content: "Use this in a server.", flags: MessageFlags.Ephemeral });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const user = await getOrCreateUser(interaction.user.id);
    if (user.verified) {
      await interaction.editReply({
        content:
          "You're already verified. Contact a moderator if you need to change your linked account.",
      });
      return;
    }

    const conflict = await findUserByMinecraftUsername(ign);
    if (conflict && conflict.discord_id !== interaction.user.id) {
      await interaction.editReply({
        content:
          "That Minecraft account is already linked to another Discord user. Contact a moderator to transfer it.",
      });
      return;
    }

    const profile = await lookupMinecraftProfile(ign);
    if (!profile) {
      await interaction.editReply({
        content: `No Java Edition account found for **${ign}**. Double-check the spelling. Only Java Edition accounts can be linked.`,
      });
      return;
    }

    const ticket = await createTicketChannel({
      guild: interaction.guild,
      ownerId: interaction.user.id,
      ownerUsername: interaction.user.username,
      kind: "verify",
      topic: `Linking ticket - Java: ${profile.name}`,
      allowAttachments: true,
    });
    if (!ticket) {
      await interaction.editReply({
        content: "Couldn't create the linking ticket. Make sure I have **Manage Channels** permission.",
      });
      return;
    }

    const discordTsJava = Math.floor(interaction.user.createdTimestamp / 1000);
    const embed = new EmbedBuilder()
      .setColor(0x22c55e)
      .setTitle("Account Linking Request - Java")
      .setDescription(
        `<@${interaction.user.id}> wants to link **Java** account **${profile.name}**.\n\nA staff member will verify ownership in-game on DonutSMP and approve below.`,
      )
      .addFields(
        { name: "Platform", value: "Java Edition", inline: true },
        { name: "Minecraft", value: `\`${profile.name}\``, inline: true },
        { name: "UUID", value: `\`${profile.id}\``, inline: true },
        {
          name: "Discord Account Age",
          value: `Created <t:${discordTsJava}:D> (<t:${discordTsJava}:R>)`,
          inline: false,
        },
      )
      .setThumbnail(`https://mc-heads.net/avatar/${profile.id}/128`)
      .setFooter({ text: "Mods: confirm in-game ownership, then click Approve." });

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`verify:approve:${interaction.user.id}:${profile.name}`)
        .setLabel("Approve")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`verify:deny:${interaction.user.id}`)
        .setLabel("Deny")
        .setStyle(ButtonStyle.Secondary),
    );

    const mention = ticket.modRoleId
      ? `<@${interaction.user.id}> · <@&${ticket.modRoleId}>`
      : `<@${interaction.user.id}>`;
    await ticket.channel.send({ content: mention, embeds: [embed], components: [row] });
    await interaction.editReply({
      content: `Linking ticket created: <#${ticket.channel.id}>\nA staff member will check your account in-game on DonutSMP.`,
    });
    return;
  }

  if (action === "verify_bedrock") {
    const ign = interaction.fields.getTextInputValue("ign").trim();
    if (ign.length < 1 || ign.length > 32) {
      await interaction.reply({
        content: "Bedrock gamertag must be 1-32 characters.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (!interaction.guild) {
      await interaction.reply({ content: "Use this in a server.", flags: MessageFlags.Ephemeral });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const user = await getOrCreateUser(interaction.user.id);
    if (user.verified) {
      await interaction.editReply({
        content:
          "You're already verified. Contact a moderator if you need to change your linked account.",
      });
      return;
    }

    const ticket = await createTicketChannel({
      guild: interaction.guild,
      ownerId: interaction.user.id,
      ownerUsername: interaction.user.username,
      kind: "verify",
      topic: `Linking ticket - Bedrock: ${ign}`,
      allowAttachments: true,
    });
    if (!ticket) {
      await interaction.editReply({
        content: "Couldn't create the linking ticket. Make sure I have **Manage Channels** permission.",
      });
      return;
    }

    const discordTsBedrock = Math.floor(interaction.user.createdTimestamp / 1000);
    const embed = new EmbedBuilder()
      .setColor(0x22c55e)
      .setTitle("Account Linking Request - Bedrock")
      .setDescription(
        `<@${interaction.user.id}> wants to link **Bedrock** account **${ign}**.\n\nA staff member will verify ownership in-game on DonutSMP and approve below.`,
      )
      .addFields(
        { name: "Platform", value: "Bedrock Edition", inline: true },
        { name: "Gamertag", value: `\`${ign}\``, inline: true },
        {
          name: "Discord Account Age",
          value: `Created <t:${discordTsBedrock}:D> (<t:${discordTsBedrock}:R>)`,
          inline: false,
        },
      )
      .setFooter({ text: "Mods: confirm in-game ownership, then click Approve." });

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`verify:approve:${interaction.user.id}:${ign}`)
        .setLabel("Approve")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`verify:deny:${interaction.user.id}`)
        .setLabel("Deny")
        .setStyle(ButtonStyle.Secondary),
    );

    const mention = ticket.modRoleId
      ? `<@${interaction.user.id}> · <@&${ticket.modRoleId}>`
      : `<@${interaction.user.id}>`;
    await ticket.channel.send({ content: mention, embeds: [embed], components: [row] });
    await interaction.editReply({
      content: `Linking ticket created: <#${ticket.channel.id}>\nA staff member will check your account in-game on DonutSMP.`,
    });
    return;
  }

  if (action === "deposit" || action === "withdraw") {
    const raw = interaction.fields.getTextInputValue("amount").trim();
    const amount = parseAmount(raw);
    if (amount === null || amount <= 0n) {
      await interaction.reply({
        content: "Invalid amount. Try formats like `1mil`, `10mil`, `100mil`, `1bil`.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const min = action === "deposit" ? MIN_DEPOSIT : MIN_WITHDRAW;
    if (amount < min) {
      await interaction.reply({
        content: `Minimum ${action} is **1mil** (1,000,000 DonutSMP $).`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (!interaction.guild) {
      await interaction.reply({ content: "Use this in a server.", flags: MessageFlags.Ephemeral });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const user = await getOrCreateUser(interaction.user.id);

    if (!user.verified || !user.minecraft_username) {
      await interaction.editReply({
        content:
          "You need to set your Minecraft username first. Click **Settings** on the panel.",
      });
      return;
    }

    if (action === "withdraw") {
      const balance = BigInt(user.balance);
      const wagerReq = BigInt(user.wager_requirement ?? "0");
      const withdrawable = balance > wagerReq ? balance - wagerReq : 0n;
      if (amount > withdrawable) {
        if (withdrawable <= 0n) {
          await interaction.editReply({
            content:
              `**Nothing available to withdraw.**\n` +
              `Your balance is locked behind a wagering requirement.\n` +
              `Keep playing to unlock it!`,
          });
        } else {
          await interaction.editReply({
            content:
              `**Amount too high.**\n` +
              `You can withdraw up to **${formatCoins(withdrawable)}** right now.\n` +
              `The remaining **${formatCoins(wagerReq)}** is locked - must gamble before withdraw.`,
          });
        }
        return;
      }
      if (amount > balance) {
        await interaction.editReply({
          content: `Insufficient balance. You have ${formatCoins(BigInt(user.balance))}.`,
        });
        return;
      }
    }

    const ticket = await createTicketChannel({
      guild: interaction.guild,
      ownerId: interaction.user.id,
      ownerUsername: interaction.user.username,
      kind: action,
      topic:
        action === "deposit"
          ? `Deposit ticket - ${amount.toString()} DonutSMP $`
          : `Withdrawal ticket - ${amount.toString()} DonutSMP $`,
      allowAttachments: action === "deposit",
    });
    if (!ticket) {
      await interaction.editReply({
        content: "Couldn't create the ticket. Make sure I have **Manage Channels** permission.",
      });
      return;
    }

    const mention = ticket.modRoleId
      ? `<@${interaction.user.id}> · <@&${ticket.modRoleId}>`
      : `<@${interaction.user.id}>`;

    if (action === "deposit") {
      const pending = await createPendingDeposit({
        discordId: interaction.user.id,
        channelId: ticket.channel.id,
        amount,
      });

      if (!pending) {
        await interaction.editReply({
          content: "Couldn't open the deposit request. Please try again.",
        });
        return;
      }

      const rawAmount = Number(amount).toString();
      const depositEmbed = new EmbedBuilder()
        .setColor(0x22c55e)
        .setTitle("Deposit Ticket")
        .setDescription(
          `Welcome <@${interaction.user.id}>!\n\n` +
          `An admin will give you their Minecraft username. Once you have it, run this command in-game:\n\n` +
          `\`\`\`/pay <admin_username> ${rawAmount}\`\`\`` +
          `The bot will **automatically detect your payment** and add it to your balance.`,
        )
        .addFields(
          {
            name: "Amount",
            value: `$${Number(amount).toLocaleString("en-US")} DonutSMP`,
            inline: true,
          },
          {
            name: "Your IGN",
            value: `\`${user.minecraft_username}\``,
            inline: true,
          },
          {
            name: "Important",
            value: `Pay from your verified account only: \`${user.minecraft_username}\``,
            inline: false,
          },
        )
        .setFooter({ text: "DonutSMP Casino - Deposit" });

      const depositBtns = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`${DEP_TICKET_BTN_PREFIX}:accept:${pending.id}:${interaction.user.id}`)
          .setLabel("Accept Deposit")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`${DEP_TICKET_BTN_PREFIX}:deny:${pending.id}:${interaction.user.id}`)
          .setLabel("Deny Deposit")
          .setStyle(ButtonStyle.Secondary),
      );

      await (ticket.channel as TextChannel).send({ content: mention, embeds: [depositEmbed], components: [depositBtns] });
      await interaction.editReply({ content: `Deposit ticket created: <#${ticket.channel.id}>` });
      return;
    }

    const newBal = await adjustBalance(interaction.user.id, -amount);
    await recordBalanceEvent({
      discordId: interaction.user.id,
      delta: -amount,
      source: "withdraw",
      detail: `Withdrawal request - pending in <#${ticket.channel.id}>`,
    });
    const pending = await createPendingWithdrawal({
      discordId: interaction.user.id,
      channelId: ticket.channel.id,
      amount,
      ign: user.minecraft_username,
    });
    if (!pending) {
      await adjustBalance(interaction.user.id, amount);
      await interaction.editReply({
        content: "Couldn't open the withdrawal request. Your balance was not deducted.",
      });
      return;
    }
    const { embed: wEmbed } = buildWithdrawEmbed({ amount, ign: user.minecraft_username, ignConfirmed: false });
    const wComponents = buildWithdrawComponents({ pendingId: pending.id, ignConfirmed: false });
    await (ticket.channel as TextChannel).send({ content: mention, embeds: [wEmbed], components: wComponents });
    await interaction.editReply({
      content:
        `Withdrawal ticket created: <#${ticket.channel.id}>\n` +
        `${formatCoins(amount)} deducted - refunded if you cancel.\n` +
        `New balance: ${formatCoins(newBal)}`,
    });
    return;
  }
}
