// Import the functions you need from the SDKs you need
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getAnalytics } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-analytics.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { getDatabase } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyCPCYQAw127B_SJcv0XHr5Ur9ENGBPhzss",
  authDomain: "chaterly-67b1d.firebaseapp.com",
  databaseURL: "https://chaterly-67b1d-default-rtdb.firebaseio.com",
  projectId: "chaterly-67b1d",
  storageBucket: "chaterly-67b1d.firebasestorage.app",
  messagingSenderId: "625410141033",
  appId: "1:625410141033:web:158508ced8e1f0ccdf2bf8",
  measurementId: "G-86FCH743GX"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);
const auth = getAuth(app);
const database = getDatabase(app);

export { app, analytics, auth, database };
