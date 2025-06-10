const nodemailer = require('nodemailer');

async function sendEmail() {
  const transporter = nodemailer.createTransport({
    host: 'smtp-relay.brevo.com',
    port: 587,
    secure: false, // no SSL
    auth: {
      user: '869803001@smtp-brevo.com',
      pass: 'xOR31NG8E4FZ6Jqd'
    },
    tls: {
      rejectUnauthorized: false // allow self-signed certs (if any)
    }
  });

  const info = await transporter.sendMail({
    from: 'tejasbansod584@gmail.com',
    to: 'user@flashsend.in',
    subject: 'Test Email from Nodemailer Brevo',
    text: 'This is a test email sent using Nodemailer with authentication with brevo server.'
  });

  console.log('Message sent:', info.messageId);
}

sendEmail().catch(console.error);
