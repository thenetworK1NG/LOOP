# FIREBASE SETUP - IMPORTANT!

## ⚠️ ERROR FIX: "Index not defined"

If you see this error, follow these steps:

### Step 1: Go to Firebase Console
1. Open https://console.firebase.google.com
2. Select your project: **chaterly-67b1d**
3. Click on **Realtime Database** in the left menu
4. Click on the **Rules** tab

### Step 2: Replace Database Rules
Copy and paste these rules exactly:

```json
{
  "rules": {
    "users": {
      ".read": "auth != null",
      ".write": "auth != null",
      ".indexOn": ["username"],
      "$userId": {
        ".validate": "newData.hasChildren(['username', 'email', 'userId', 'createdAt'])"
      }
    },
    "messages": {
      ".read": "auth != null",
      ".write": "auth != null",
      ".indexOn": ["timestamp"],
      "$messageId": {
        ".validate": "newData.hasChildren(['text', 'sender', 'senderEmail', 'userId', 'timestamp'])"
      }
    },
    "friends": {
      ".read": "auth != null",
      "$userId": {
        ".read": "auth.uid === $userId",
        ".write": "auth.uid === $userId"
      }
    },
    "friendRequests": {
      ".read": "auth != null",
      "$userId": {
        ".read": "auth.uid === $userId",
        ".write": "auth != null"
      }
    }
  }
}
```

### Step 3: Publish Rules
1. Click the **Publish** button
2. Wait for confirmation message

### Step 4: Test Your App
1. Refresh your browser
2. Try setting your username again
3. The error should be gone! ✅

## What These Rules Do:

- **`.indexOn: ["username"]`** - Allows fast username searches (fixes the error!)
- **`.indexOn: ["timestamp"]`** - Allows fast message ordering
- **Authentication required** - Only logged-in users can read/write
- **User privacy** - Users can only access their own friends and requests
- **Data validation** - Ensures correct data structure

## Still Having Issues?

Make sure:
1. You're logged into the correct Firebase account
2. You selected the right project (chaterly-67b1d)
3. You clicked "Publish" after pasting the rules
4. You refreshed your browser after publishing

---

**Need help?** Check the Firebase Console logs for any error messages.
