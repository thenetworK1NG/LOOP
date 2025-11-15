# Chaterly - Real-time Chat Application

A modern real-time chat application built with Firebase Realtime Database and Firebase Authentication.

## Features

- ✨ Real-time messaging
- 🔐 Email and password authentication
- 👥 User profiles with display names
- 📱 Responsive design
- 🎨 Modern UI with gradient themes
- ⚡ Instant message delivery
- 🔒 Secure authentication

## Setup Instructions

1. **Open the application**
   - Simply open `index.html` in a web browser to start using the application

2. **Create an account**
   - Click on the "Sign Up" tab
   - Enter your display name, email, and password
   - Click "Sign Up" to create your account

3. **Login**
   - Enter your email and password
   - Click "Login" to access the chat

4. **Start chatting**
   - Type your message in the input field
   - Press Enter or click the send button
   - Your messages will appear in real-time for all users

## File Structure

```
chaterly/
├── index.html          # Login/Signup page
├── chat.html           # Main chat interface
├── style.css           # Styles for all pages
├── firebase-config.js  # Firebase configuration
├── auth.js             # Authentication logic
├── chat.js             # Chat functionality
└── README.md           # This file
```

## Technologies Used

- HTML5
- CSS3
- JavaScript (ES6 Modules)
- Firebase Authentication
- Firebase Realtime Database
- Firebase Analytics

## Features Detail

### Authentication
- Email/password signup
- Email/password login
- Password validation (minimum 6 characters)
- Display name support
- Secure logout

### Chat Features
- Real-time message synchronization
- Message timestamps
- User identification
- Auto-scroll to latest messages
- Message history (last 100 messages)
- XSS protection

## Browser Support

Works on all modern browsers that support ES6 modules:
- Chrome (latest)
- Firefox (latest)
- Safari (latest)
- Edge (latest)

## Security Notes

- All authentication is handled securely by Firebase
- Messages are stored in Firebase Realtime Database
- User input is sanitized to prevent XSS attacks
- Firebase security rules should be configured for production use

## Firebase Console Setup (REQUIRED)

You MUST configure these Firebase Realtime Database Rules for the app to work:

### Realtime Database Rules
Go to Firebase Console → Realtime Database → Rules and paste this:

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

### Authentication
- Email/Password authentication is enabled by default in your Firebase project

## Deployment

To deploy this application:
1. Upload all files to a web server or hosting service
2. Ensure all files are in the same directory
3. Access via the hosted URL

## Support

For issues or questions about Firebase configuration, visit:
- [Firebase Documentation](https://firebase.google.com/docs)
- [Firebase Console](https://console.firebase.google.com)

---

Built with ❤️ using Firebase
