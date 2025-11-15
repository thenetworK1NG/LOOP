Push notification quickstart (server)

This project now supports web push. Below are steps to test sending push notifications to subscriptions saved by the client.

1) Install dependencies (Node.js server side)

   npm install web-push

2) Prepare a subscription JSON

   - When a user subscribes via the app, the subscription is saved to Firebase under `users/<uid>/pushSubscription`.
   - To test locally, you can also save the PushSubscription object to a file `subscription.json` and use the example script.

3) Configure VAPID keys

   - You provided the VAPID keys; the client code (`chat.js`) already contains the public key.
   - The example server script `send-push.js` contains the public and private keys. Keep the private key secret.

4) Send a test push

   - Save a subscription JSON to `subscription.json` (or export it from Firebase and save locally).
   - Run:

     node send-push.js subscription.json "Test title" "Hello from server"

   - If successful, the service worker will show a notification on the device/browser associated with the subscription.

Notes & troubleshooting

- The service worker and Push API require HTTPS (or `http://localhost`).
- If the push fails with HTTP 404 / 410, the subscription is probably invalid or expired — remove it from the DB and re-subscribe from the client.
- On Android, installed PWAs receive push notifications via the service worker even when the app is closed.
- On iOS, web push for Safari is supported only on newer versions and has platform-specific limits.

If you'd like, I can:
- Add a small server example that reads subscriptions from Firebase and broadcasts to all users.
- Add automatic removal of invalid subscriptions server-side when push responses indicate unsubscribe.
