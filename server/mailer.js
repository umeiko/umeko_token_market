import nodemailer from 'nodemailer';

const smtpConfigured = Boolean(process.env.SMTP_HOST);
const transport = smtpConfigured ? nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: process.env.SMTP_SECURE === 'true',
  auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || '' } : undefined,
  connectionTimeout: 10000,
  greetingTimeout: 10000,
  socketTimeout: 15000,
}) : null;

export const isDevelopmentEmail = () => process.env.EMAIL_DEV_MODE === 'true' || (!smtpConfigured && process.env.NODE_ENV !== 'production');

export async function sendVerificationEmail(email, code) {
  if (!transport) {
    if (isDevelopmentEmail()) {
      console.log(`[DEV EMAIL] Verification code for ${email}: ${code}`);
      return;
    }
    throw Object.assign(new Error('邮件服务尚未配置，请联系管理员'), { statusCode: 503 });
  }
  await transport.sendMail({
    from: process.env.EMAIL_FROM || process.env.SMTP_USER,
    to: email,
    subject: `${code} · Umeko Token Relay 验证码`,
    text: `你的 Umeko Token Relay 验证码是 ${code}，10 分钟内有效。\n\n如果这不是你的操作，请忽略此邮件。`,
    html: `<div style="font-family:system-ui,sans-serif;max-width:520px;margin:auto;padding:32px;color:#183b47"><h2>Umeko Token Relay</h2><p>你的邮箱验证码：</p><div style="font-size:34px;letter-spacing:8px;font-weight:700;color:#087f95;padding:20px 0">${code}</div><p>验证码 10 分钟内有效。如果这不是你的操作，请忽略此邮件。</p></div>`,
  });
}
