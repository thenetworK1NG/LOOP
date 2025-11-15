# How to Fix Firebase Permission Error

You're getting a `PERMISSION_DENIED` error because Firebase Realtime Database security rules need to be configured.

## Steps to Fix:

### 1. Go to Firebase Console
Visit: https://console.firebase.google.com

### 2. Select Your Project
Click on your project: **chaterly-67b1d**

### 3. Navigate to Realtime Database
- In the left sidebar, click **Build** → **Realtime Database**
- Click on the **Rules** tab at the top

### 4. Replace the Rules
Copy and paste the rules from `firebase-rules.json` into the Firebase Console:

```json
{
  "rules": {
    "users": {
      ".read": "auth != null",
      ".indexOn": ["username"],
      "$userId": {
        ".read": "auth != null",
        ".write": "$userId === auth.uid"
      }
    },
    "friends": {
      "$userId": {
        ".read": "$userId === auth.uid",
        ".write": "auth != null",
        "$friendId": {
          ".read": "$userId === auth.uid",
          ".write": "auth != null"
        }
      }
    },
    "friendRequests": {
      "$userId": {
        ".read": "$userId === auth.uid",
        ".write": "auth != null",
        "$requestId": {
          ".read": "$userId === auth.uid || $requestId === auth.uid",
          ".write": "auth != null"
        }
      }
    },
    "chatRooms": {
      "$chatRoomId": {
        ".read": "auth != null",
        ".write": "auth != null",
        "messages": {
          ".read": "auth != null",
          ".write": "auth != null"
        }
      }
    }
  }
}
```

### 5. Publish the Rules
- Click the **Publish** button
- Wait for confirmation that rules are published

### 6. Test Your App
- Refresh your chat application
- Try accepting a friend request again
- It should now work without permission errors!

## What These Rules Do:

- **users**: Users can read any user data if authenticated, but only write their own data
- **friends**: Users can only read and write their own friends list
- **friendRequests**: Users can read their own requests and write to send requests to others
- **chatRooms**: Authenticated users can read and write messages in chat rooms

## Alternative: Development Mode (NOT RECOMMENDED FOR PRODUCTION)

If you want to quickly test without security (⚠️ ONLY for development):

```json
{
  "rules": {
    ".read": "auth != null",
    ".write": "auth != null"
  }
}
```

**Warning:** This allows any authenticated user to read/write everything. Use only for testing!
