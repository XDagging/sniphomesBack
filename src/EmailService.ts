import nodemailer from 'nodemailer';
import type { EmailBookingConfig } from './types/index';

export async function sendBookingEmail(
  config: EmailBookingConfig,
  data: Record<string, string>,
  callerPhone: string,
): Promise<{ success: boolean; error?: string }> {
  const gmailUser     = process.env.GMAIL_USER        ?? '';
  const gmailPassword = process.env.GMAIL_APP_PASSWORD ?? '';

  if (!gmailUser || !gmailPassword) {
    return { success: false, error: 'Gmail credentials not configured (GMAIL_USER / GMAIL_APP_PASSWORD).' };
  }

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: gmailUser, pass: gmailPassword },
  });

  const name        = data[config.fieldMapping.name]            ?? 'N/A';
  const phone       = data[config.fieldMapping.phone]           ?? callerPhone ?? 'N/A';
  const jobDesc     = data[config.fieldMapping.jobDescription]  ?? 'N/A';
  const address     = config.fieldMapping.address
    ? (data[config.fieldMapping.address] ?? 'Not provided')
    : 'Not provided';

  const subject = `New Booking Request — ${name}`;

  const text = [
    'New booking request received via S and M Powerwashing AI receptionist.',
    '',
    `Name:              ${name}`,
    `Phone:             ${phone}`,
    `Job Description:   ${jobDesc}`,
    `Address:           ${address}`,
    '',
    `Received: ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} EST`,
  ].join('\n');

  const html = `
    <h2>New Booking Request — S and M Powerwashing</h2>
    <table cellpadding="6" style="border-collapse:collapse;font-family:sans-serif;">
      <tr><td><strong>Name</strong></td><td>${name}</td></tr>
      <tr><td><strong>Phone</strong></td><td>${phone}</td></tr>
      <tr><td><strong>Job Description</strong></td><td>${jobDesc}</td></tr>
      <tr><td><strong>Address</strong></td><td>${address}</td></tr>
      <tr><td><strong>Received</strong></td><td>${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} EST</td></tr>
    </table>
  `;

  try {
    await transporter.sendMail({
      from:    `"S and M Powerwashing Bookings" <${gmailUser}>`,
      to:      config.recipientEmail,
      subject,
      text,
      html,
    });
    return { success: true };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { success: false, error: msg };
  }
}
