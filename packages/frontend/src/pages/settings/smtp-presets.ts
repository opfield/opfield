export const SMTP_PRESETS = {
  generic: {
    label: "Generic SMTP",
    description: "Configure any standards-compliant SMTP relay manually.",
  },
  resend: {
    label: "Resend",
    description: "smtp.resend.com · STARTTLS · API key as the password",
    host: "smtp.resend.com",
    port: "587",
    tlsMode: "starttls" as const,
    username: "resend",
  },
  postmark: {
    label: "Postmark",
    description: "smtp.postmarkapp.com · STARTTLS · SMTP or Server API token",
    host: "smtp.postmarkapp.com",
    port: "587",
    tlsMode: "starttls" as const,
    username: "",
  },
  sendgrid: {
    label: "Twilio SendGrid",
    description: "smtp.sendgrid.net · STARTTLS · API key as the password",
    host: "smtp.sendgrid.net",
    port: "587",
    tlsMode: "starttls" as const,
    username: "apikey",
  },
} as const;

export type SmtpPresetId = keyof typeof SMTP_PRESETS;

export interface SmtpDraft {
  host: string;
  port: string;
  tlsMode: "starttls" | "tls";
  username: string;
  password: string;
  senderName: string;
  senderEmail: string;
}

export const DEFAULT_SMTP_DRAFT: SmtpDraft = {
  host: SMTP_PRESETS.resend.host,
  port: SMTP_PRESETS.resend.port,
  tlsMode: SMTP_PRESETS.resend.tlsMode,
  username: SMTP_PRESETS.resend.username,
  password: "",
  senderName: "Opfield",
  senderEmail: "",
};

export function getSmtpPresetId(host: string | null | undefined): SmtpPresetId {
  return (Object.entries(SMTP_PRESETS).find(
    ([, preset]) => "host" in preset && preset.host === host
  )?.[0] ?? "generic") as SmtpPresetId;
}

export function applySmtpPreset(draft: SmtpDraft, presetId: SmtpPresetId): SmtpDraft {
  const preset = SMTP_PRESETS[presetId];
  if (!("host" in preset)) return draft;
  return {
    ...draft,
    host: preset.host,
    port: preset.port,
    tlsMode: preset.tlsMode,
    username: preset.username,
  };
}
