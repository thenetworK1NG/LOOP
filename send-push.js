// Example Node.js script to send a Web Push notification to a saved subscription
// Usage:
// 1) npm install web-push
// 2) Create a JSON file containing the subscription (for example `subscription.json`) with the PushSubscription object saved from the client
// 3) node send-push.js subscription.json "Message title" "Message body"

const webpush = require('web-push');
const fs = require('fs');
const path = require('path');

// Replace with your VAPID keys (the private key must be kept secret)
const VAPID_PUBLIC_KEY = 'BOvlFaMCX3DrMrF0KnoafL8ZcEhSxvfCk_lrlIHG8OsDv2K5VKHs7G9XQhZx0mhtMI2gkGogwzbMbiT0UnDL3LI';
const VAPID_PRIVATE_KEY = 'Lv5DUlrqo9BorfHiPQ7GtavZ6veCoqyBVoE42RYkJ0Y';

webpush.setVapidDetails(
  'mailto:you@example.com',
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY
);

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error('Usage: node send-push.js <subscription.json> [title] [body]');
    process.exit(1);
  }

  const subFile = args[0];
  const title = args[1] || 'Chaterly — New message';
  const body = args[2] || 'You have a new message';

  const subPath = path.resolve(process.cwd(), subFile);
  if (!fs.existsSync(subPath)) {
    console.error('Subscription file not found:', subPath);
    process.exit(1);
  }

  let subscription = null;
  try {
    subscription = JSON.parse(fs.readFileSync(subPath, 'utf8'));
  } catch (err) {
    console.error('Failed to read subscription JSON:', err);
    process.exit(1);
  }

  const payload = JSON.stringify({ title, body, data: { example: true } });

  try {
    const res = await webpush.sendNotification(subscription, payload, { TTL: 60 });
    console.log('Push sent, status:', res.statusCode);
  } catch (err) {
    console.error('Error sending push:', err.statusCode || err);
    if (err.body) console.error('Body:', err.body.toString());
  }
}

main();
