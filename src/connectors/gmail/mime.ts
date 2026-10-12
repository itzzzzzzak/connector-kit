// Builds the base64url "raw" RFC 2822 message that Gmail's send and draft calls take. Plain text or HTML body, UTF-8 throughout.
// Headers are refused when they contain a line break: that is how a header gets injected ("Bcc: ..." hidden in a subject).

export interface OutgoingMail {
  to: string[]
  cc?: string[] | undefined
  bcc?: string[] | undefined
  subject: string
  body: string
  html?: boolean | undefined
  /** The Message-ID header of the message being replied to; sets In-Reply-To and References so clients thread the reply. */
  inReplyTo?: string | undefined
}

const safe = (value: string): boolean => !/[\r\n\0]/.test(value)
const wrap = (text: string): string => text.replace(/(.{76})/g, "$1\r\n")
const encodeWord = (text: string): string => (/^[\x20-\x7e]*$/.test(text) ? text : `=?UTF-8?B?${Buffer.from(text, "utf8").toString("base64")}?=`)

/** Throws a plain Error naming the bad field; the connector's zod refinements catch the same cases first. */
export function buildRawMessage(mail: OutgoingMail): string {
  const lists: Array<[string, string[] | undefined]> = [["To", mail.to], ["Cc", mail.cc], ["Bcc", mail.bcc]]
  const lines: string[] = ["MIME-Version: 1.0"]
  for (const [name, addresses] of lists) {
    if (!addresses || addresses.length === 0) continue
    if (!addresses.every(safe)) throw new Error(`${name} contains a line break`)
    lines.push(`${name}: ${addresses.join(", ")}`)
  }
  if (!safe(mail.subject)) throw new Error("subject contains a line break")
  lines.push(`Subject: ${encodeWord(mail.subject)}`)
  if (mail.inReplyTo) {
    if (!safe(mail.inReplyTo)) throw new Error("inReplyTo contains a line break")
    lines.push(`In-Reply-To: ${mail.inReplyTo}`, `References: ${mail.inReplyTo}`)
  }
  lines.push(`Content-Type: ${mail.html ? "text/html" : "text/plain"}; charset="UTF-8"`, "Content-Transfer-Encoding: base64")
  const message = `${lines.join("\r\n")}\r\n\r\n${wrap(Buffer.from(mail.body, "utf8").toString("base64"))}\r\n`
  return Buffer.from(message, "utf8").toString("base64url")
}
