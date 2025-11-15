import { auth } from './firebase-config.js';
import { 
    createUserWithEmailAndPassword, 
    signInWithEmailAndPassword,
    onAuthStateChanged,
    updateProfile
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

import { database } from './firebase-config.js';
import { ref, get } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";

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

// Check if user is already logged in
onAuthStateChanged(auth, async (user) => {
    if (user) {
        // Check if user has username set
        const userRef = ref(database, `users/${user.uid}`);
        const snapshot = await get(userRef);
        
        if (!snapshot.exists() || !snapshot.val().username) {
            window.location.href = 'setup-username.html';
        } else {
            window.location.href = 'chat.html';
        }
    }
});

// Tab switching functions
window.showLogin = function() {
    document.getElementById('loginForm').style.display = 'block';
    document.getElementById('signupForm').style.display = 'none';
    document.querySelectorAll('.tab-btn')[0].classList.add('active');
    document.querySelectorAll('.tab-btn')[1].classList.remove('active');
    clearErrors();
}

window.showSignup = function() {
    document.getElementById('loginForm').style.display = 'none';
    document.getElementById('signupForm').style.display = 'block';
    document.querySelectorAll('.tab-btn')[0].classList.remove('active');
    document.querySelectorAll('.tab-btn')[1].classList.add('active');
    clearErrors();
}

function clearErrors() {
    document.getElementById('loginError').textContent = '';
    document.getElementById('signupError').textContent = '';
}

// Login Form Handler
document.getElementById('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const email = document.getElementById('loginEmail').value;
    const password = document.getElementById('loginPassword').value;
    const errorElement = document.getElementById('loginError');
    
    try {
        errorElement.textContent = '';
        await signInWithEmailAndPassword(auth, email, password);
        // Redirect happens automatically through onAuthStateChanged
    } catch (error) {
        console.error('Login error:', error);
        switch (error.code) {
            case 'auth/invalid-email':
                errorElement.textContent = 'Invalid email address.';
                break;
            case 'auth/user-disabled':
                errorElement.textContent = 'This account has been disabled.';
                break;
            case 'auth/user-not-found':
                errorElement.textContent = 'No account found with this email.';
                break;
            case 'auth/wrong-password':
                errorElement.textContent = 'Incorrect password.';
                break;
            case 'auth/invalid-credential':
                errorElement.textContent = 'Invalid email or password.';
                break;
            default:
                errorElement.textContent = 'Login failed. Please try again.';
        }
    }
});

// Signup Form Handler
document.getElementById('signupForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const name = document.getElementById('signupName').value;
    const email = document.getElementById('signupEmail').value;
    const password = document.getElementById('signupPassword').value;
    const confirmPassword = document.getElementById('signupPasswordConfirm').value;
    const errorElement = document.getElementById('signupError');
    
    try {
        errorElement.textContent = '';
        
        // Validate passwords match
        if (password !== confirmPassword) {
            errorElement.textContent = 'Passwords do not match.';
            return;
        }
        
        // Validate password length
        if (password.length < 6) {
            errorElement.textContent = 'Password must be at least 6 characters.';
            return;
        }
        
        // Create user
        const userCredential = await createUserWithEmailAndPassword(auth, email, password);
        
        // Redirect to username setup (happens automatically through onAuthStateChanged)
    } catch (error) {
        console.error('Signup error:', error);
        switch (error.code) {
            case 'auth/email-already-in-use':
                errorElement.textContent = 'This email is already registered.';
                break;
            case 'auth/invalid-email':
                errorElement.textContent = 'Invalid email address.';
                break;
            case 'auth/operation-not-allowed':
                errorElement.textContent = 'Email/password accounts are not enabled.';
                break;
            case 'auth/weak-password':
                errorElement.textContent = 'Password is too weak.';
                break;
            default:
                errorElement.textContent = 'Signup failed. Please try again.';
        }
    }
});
