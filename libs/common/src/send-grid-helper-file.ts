import axios from 'axios';
import * as sendgrid from '@sendgrid/mail';
import * as dotenv from 'dotenv';
import { EmailDto } from './dtos/email.dto';

dotenv.config();

type EmailProvider = 'sendgrid' | 'resend';

const resendApiUrl = 'https://api.resend.com/emails';

const getEmailProvider = (): EmailProvider => {
  const provider = `${process.env.EMAIL_PROVIDER || 'sendgrid'}`.trim().toLowerCase();

  return 'resend' === provider ? 'resend' : 'sendgrid';
};

const sendWithSendGrid = async (emailDto: EmailDto): Promise<boolean> => {
  if (!process.env.SENDGRID_API_KEY) {
    return false;
  }

  sendgrid.setApiKey(process.env.SENDGRID_API_KEY);

  const msg = {
    to: emailDto.emailTo,
    from: emailDto.emailFrom,
    subject: emailDto.emailSubject,
    text: emailDto.emailText,
    html: emailDto.emailHtml,
    attachments: emailDto.emailAttachments
  };

  return sendgrid
    .send(msg)
    .then(() => true)
    .catch(() => false);
};

const sendWithResend = async (emailDto: EmailDto): Promise<boolean> => {
  if (!process.env.RESEND_API_KEY) {
    return false;
  }

  const payload = {
    to: [emailDto.emailTo],
    from: emailDto.emailFrom,
    subject: emailDto.emailSubject,
    text: emailDto.emailText,
    html: emailDto.emailHtml,
    attachments: emailDto.emailAttachments?.map((attachment) => ({
      content: attachment.content,
      filename: attachment.filename,
      contentType: attachment.contentType
    }))
  };

  return axios
    .post(process.env.RESEND_API_URL || resendApiUrl, payload, {
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      }
    })
    .then(() => true)
    .catch(() => false);
};

export const sendEmail = async (emailDto: EmailDto): Promise<boolean> => {
  try {
    return 'resend' === getEmailProvider() ? sendWithResend(emailDto) : sendWithSendGrid(emailDto);
  } catch (error) {
    return false;
  }
};
