import nodemailer from 'nodemailer'
import { appendEmailSignature } from '@/lib/brand'
import { getBrand } from '@/lib/brand-server'

/** Plain-text email (spec D13): the stored branding signature, if any, is appended to every body. */

export async function sendEmail(toEmail: string, subject: string, body: string): Promise<void> {
  const host = process.env.SMTP_HOST
  const port = process.env.SMTP_PORT
  const user = process.env.SMTP_USER
  const password = process.env.SMTP_PASSWORD
  const from = process.env.SMTP_FROM
  if (!host || !port || !user || !password || !from) {
    throw new Error('Email sign-in is not configured (missing SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASSWORD/SMTP_FROM).')
  }

  const transporter = nodemailer.createTransport({
    host,
    port: Number(port),
    secure: Number(port) === 465,
    auth: { user, pass: password },
  })

  const { emailSignature } = await getBrand()
  await transporter.sendMail({ from, to: toEmail, subject, text: appendEmailSignature(body, emailSignature) })
}
