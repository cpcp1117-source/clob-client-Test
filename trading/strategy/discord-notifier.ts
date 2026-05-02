import { config as dotenvConfig } from "dotenv";
import { resolve } from "path";

dotenvConfig({ path: resolve(import.meta.dirname, "../../.env") });

const DISCORD_MAX_LENGTH = 1900;

function getWebhookUrl(): string | null {
    const webhookUrl = process.env.DISCORD_WEBHOOK_URL || process.env.DISCORD_WEBHOOK || "";
    if (!webhookUrl) return null;
    if (webhookUrl.includes("your_webhook_here")) return null;
    if (!/^https:\/\/(?:discord|canary\.discord|ptb\.discord)\.com\/api\/webhooks\//.test(webhookUrl)) {
        return null;
    }
    return webhookUrl;
}

function getBotConfig(): { token: string; channelId: string } | null {
    const token = process.env.DISCORD_BOT_TOKEN;
    const channelId = process.env.DISCORD_CHANNEL_ID;
    if (!token || !channelId) return null;
    return { token, channelId };
}

export async function sendDiscordNotification(message: string): Promise<void> {
    const content = message.length > DISCORD_MAX_LENGTH
        ? `${message.slice(0, DISCORD_MAX_LENGTH - 3)}...`
        : message;

    const webhookUrl = getWebhookUrl();
    if (webhookUrl) {
        await sendViaWebhook(webhookUrl, content);
        return;
    }

    const botConfig = getBotConfig();
    if (botConfig) {
        await sendViaBot(botConfig.token, botConfig.channelId, content);
    }
}

export async function sendDiscordNotificationToChannel(message: string, channelId: string): Promise<void> {
    const content = message.length > DISCORD_MAX_LENGTH
        ? `${message.slice(0, DISCORD_MAX_LENGTH - 3)}...`
        : message;

    const botConfig = getBotConfig();
    if (botConfig) {
        await sendViaBot(botConfig.token, channelId, content);
        return;
    }

    await sendDiscordNotification(content);
}

async function sendViaWebhook(webhookUrl: string, content: string): Promise<void> {
    try {
        const response = await fetch(webhookUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ content }),
        });

        if (!response.ok) {
            const body = await response.text().catch(() => "");
            console.error(`Discord notification failed: ${response.status} ${body}`);
        }
    } catch (error) {
        console.error("Discord notification failed:", error);
    }
}

async function sendViaBot(token: string, channelId: string, content: string): Promise<void> {
    try {
        const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
            method: "POST",
            headers: {
                authorization: `Bot ${token}`,
                "content-type": "application/json",
            },
            body: JSON.stringify({ content }),
        });

        if (!response.ok) {
            const body = await response.text().catch(() => "");
            console.error(`Discord bot notification failed: ${response.status} ${body}`);
        }
    } catch (error) {
        console.error("Discord bot notification failed:", error);
    }
}

export function sendDiscordNotificationNow(message: string): void {
    void sendDiscordNotification(message);
}

if (process.argv[1]?.endsWith("discord-notifier.ts")) {
    await sendDiscordNotification("Polymarket simulator Discord webhook test.");
}
