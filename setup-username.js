import { auth, database } from './firebase-config.js';
import { 
    onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { 
    ref, 
    set,
    get,
    query,
    orderByChild,
    equalTo,
    update
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";

let currentUser = null;

// Load saved gradient on page load
function loadSavedGradient() {
    const savedGradient = localStorage.getItem('userGradient');
    if (savedGradient) {
        const [color1, color2] = savedGradient.split(',');
        const gradient = `linear-gradient(135deg, #${color1} 0%, #${color2} 100%)`;
        document.documentElement.style.setProperty('--primary-gradient', gradient);
    }
}

// Apply gradient immediately
loadSavedGradient();

// Check authentication state
onAuthStateChanged(auth, async (user) => {
    if (user) {
        currentUser = user;
        
        // Check if user already has a username
        const userRef = ref(database, `users/${user.uid}`);
        const snapshot = await get(userRef);
        
        if (snapshot.exists() && snapshot.val().username) {
            // User already has username, redirect to chat
            window.location.href = 'chat.html';
        }
    } else {
        // User is signed out, redirect to login
        window.location.href = 'index.html';
    }
});

// Username Form Handler
document.getElementById('usernameForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const usernameInput = document.getElementById('username');
    const username = usernameInput.value.trim().toLowerCase();
    const errorElement = document.getElementById('usernameError');
    
    if (!currentUser) return;
    
    try {
        errorElement.textContent = '';
        
        // Validate username format
        const usernameRegex = /^[a-z0-9_]{3,20}$/;
        if (!usernameRegex.test(username)) {
            errorElement.textContent = 'Invalid username format.';
            return;
        }
        
        // Check if username is already taken
        const usersRef = ref(database, 'users');
        const usernameQuery = query(usersRef, orderByChild('username'), equalTo(username));
        const snapshot = await get(usernameQuery);
        
        if (snapshot.exists()) {
            errorElement.textContent = 'Username is already taken. Please choose another.';
            return;
        }
        
        // Save username to database
        const userRef = ref(database, `users/${currentUser.uid}`);
        await set(userRef, {
            username: username,
            email: currentUser.email,
            userId: currentUser.uid,
            createdAt: Date.now()
        });
        
        // Redirect to chat
        window.location.href = 'chat.html';
        
    } catch (error) {
        console.error('Error setting username:', error);
        errorElement.textContent = 'Failed to set username. Please try again.';
    }
});

// Auto-lowercase and validate as user types
document.getElementById('username').addEventListener('input', (e) => {
    e.target.value = e.target.value.toLowerCase();
});
