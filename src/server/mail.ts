import "server-only";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import nodemailer from "nodemailer";
import { appOrigin } from "./http";

export async function deliverCode(email: string, code: string, deliveryId: string): Promise<void> {
  return deliverMessage(email, "Your Family Belongings sign-in code", `Your sign-in code is ${code}. It expires in 10 minutes and can be used once. If you did not request it, ignore this message.`, deliveryId);
}

export async function deliverInvitation(email: string, collectionName: string, invitationId: string): Promise<void> {
  const link = new URL(`/invitations/${invitationId}`, appOrigin()).toString();
  const text = `You are invited to join the family collection “${collectionName}”.\n\nOpen ${link}\n\nSign in as ${email} and review the joining terms before accepting. This invitation expires in seven days. A forwarded link does not grant access. If you were not expecting this invitation, ignore it.`;
  return deliverMessage(email, "Your family collection invitation", text, invitationId);
}

async function deliverMessage(email: string, subject: string, text: string, deliveryId: string): Promise<void> {
  if (process.env.MAIL_TRANSPORT === "file") {
    if (process.env.NODE_ENV === "production" || !process.env.TURSO_DATABASE_URL?.startsWith("file:")) {
      throw new Error("File email delivery is restricted to local development databases.");
    }
    const configured = process.env.MAIL_OUTBOX_DIR;
    if (!configured) throw new Error("MAIL_OUTBOX_DIR is required.");
    const dir = resolve(configured);
    const publicDir = resolve("public");
    if (dir === publicDir || dir.startsWith(publicDir + sep)) throw new Error("Outbox cannot be public.");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(resolve(dir, `${deliveryId}.json`), JSON.stringify({ to: email, subject, text }), { mode: 0o600, flag: "wx" });
    return;
  }
  if (process.env.MAIL_TRANSPORT !== "smtp") throw new Error("Configure an email transport.");
  const host = process.env.MAIL_SMTP_HOST;
  const from = process.env.MAIL_FROM;
  const user = process.env.MAIL_SMTP_USER;
  const pass = process.env.MAIL_SMTP_PASSWORD;
  const port = Number(process.env.MAIL_SMTP_PORT || "465");
  if (!host || !from || !user || !pass || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Incomplete SMTP configuration.");
  }
  const transport = nodemailer.createTransport({
    host, port, secure: port === 465, requireTLS: true,
    auth: { user, pass },
    connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 15_000,
    logger: false, debug: false,
  });
  await transport.sendMail({ from, to: email, subject, text });
}
