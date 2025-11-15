import { auth, database } from './firebase-config.js';
import { 
    onAuthStateChanged,
    signOut
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { 
    ref, 
    get,
    set,
    remove,
    onValue,
    query,
    orderByChild,
    equalTo
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";

let currentUser = null;
let currentUsername = null;

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
        
        // Get user's username
        const userRef = ref(database, `users/${user.uid}`);
        const snapshot = await get(userRef);
        
        if (!snapshot.exists() || !snapshot.val().username) {
            // No username set, redirect to setup
            window.location.href = 'setup-username.html';
            return;
        }
        
        currentUsername = snapshot.val().username;
        
        // Load contacts and requests
        loadContacts();
        loadPendingRequests();
        loadSentRequests();
        
    } else {
        window.location.href = 'index.html';
    }
});

// Back to chat
const backBtn = document.getElementById('backToChatBtn');
if (backBtn) {
    backBtn.addEventListener('click', () => {
        window.location.href = 'chat.html';
    });
}

// Send friend request
document.getElementById('sendRequestBtn').addEventListener('click', async () => {
    const searchUsername = document.getElementById('searchUsername').value.trim().toLowerCase();
    const errorElement = document.getElementById('addFriendError');
    
    if (!searchUsername) {
        errorElement.textContent = 'Please enter a username.';
        return;
    }
    
    if (searchUsername === currentUsername) {
        errorElement.textContent = 'You cannot add yourself.';
        return;
    }
    
    try {
        errorElement.textContent = '';
        
        // Find user by username
        const usersRef = ref(database, 'users');
        const usernameQuery = query(usersRef, orderByChild('username'), equalTo(searchUsername));
        const snapshot = await get(usernameQuery);
        
        if (!snapshot.exists()) {
            errorElement.textContent = 'User not found.';
            return;
        }
        
        const targetUserId = Object.keys(snapshot.val())[0];
        const targetUser = snapshot.val()[targetUserId];
        
        // Check if already friends
        const friendRef = ref(database, `friends/${currentUser.uid}/${targetUserId}`);
        const friendSnapshot = await get(friendRef);
        
        if (friendSnapshot.exists()) {
            errorElement.textContent = 'Already in your contacts.';
            return;
        }
        
        // Check if request already sent
        const sentRequestRef = ref(database, `friendRequests/${targetUserId}/${currentUser.uid}`);
        const sentRequestSnapshot = await get(sentRequestRef);
        
        if (sentRequestSnapshot.exists()) {
            errorElement.textContent = 'Request already sent.';
            return;
        }
        
        // Check if they already sent you a request
        const receivedRequestRef = ref(database, `friendRequests/${currentUser.uid}/${targetUserId}`);
        const receivedRequestSnapshot = await get(receivedRequestRef);
        
        if (receivedRequestSnapshot.exists()) {
            errorElement.textContent = 'This user has already sent you a request. Check pending requests!';
            return;
        }
        
        // Send friend request
        await set(sentRequestRef, {
            from: currentUser.uid,
            fromUsername: currentUsername,
            fromEmail: currentUser.email,
            to: targetUserId,
            toUsername: targetUser.username,
            toEmail: targetUser.email,
            timestamp: Date.now(),
            status: 'pending'
        });
        
        document.getElementById('searchUsername').value = '';
        errorElement.style.color = '#4caf50';
        errorElement.textContent = `Request sent to @${searchUsername}!`;
        
        setTimeout(() => {
            errorElement.textContent = '';
            errorElement.style.color = '#e74c3c';
        }, 3000);
        
    } catch (error) {
        console.error('Error sending request:', error);
        errorElement.textContent = 'Failed to send request. Please try again.';
    }
});

// Load pending friend requests
function loadPendingRequests() {
    const requestsRef = ref(database, `friendRequests/${currentUser.uid}`);
    
    onValue(requestsRef, (snapshot) => {
        const requestsList = document.getElementById('pendingRequestsList');
        const badge = document.getElementById('pendingBadge');
        
        requestsList.innerHTML = '';
        
        if (!snapshot.exists()) {
            requestsList.innerHTML = '<p class="empty-message">No pending requests</p>';
            badge.textContent = '0';
            return;
        }
        
        const requests = snapshot.val();
        const requestsArray = Object.entries(requests);
        badge.textContent = requestsArray.length;
        
        requestsArray.forEach(([requestId, request]) => {
            const requestItem = document.createElement('div');
            requestItem.className = 'request-item';
            requestItem.innerHTML = `
                <div class="request-info">
                    <span class="request-username">@${escapeHtml(request.fromUsername)}</span>
                    <span class="request-email">${escapeHtml(request.fromEmail)}</span>
                </div>
                <div class="request-actions">
                    <button class="btn-accept" data-request-id="${requestId}" data-request='${JSON.stringify(request)}'>Accept</button>
                    <button class="btn-reject" data-request-id="${requestId}">Reject</button>
                </div>
            `;
            requestsList.appendChild(requestItem);
        });
        
        // Add event listeners
        document.querySelectorAll('.btn-accept').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const request = JSON.parse(e.target.dataset.request);
                acceptRequest(e.target.dataset.requestId, request);
            });
        });
        
        document.querySelectorAll('.btn-reject').forEach(btn => {
            btn.addEventListener('click', (e) => {
                rejectRequest(e.target.dataset.requestId);
            });
        });
    });
}

// Load sent requests
function loadSentRequests() {
    const allRequestsRef = ref(database, 'friendRequests');
    
    onValue(allRequestsRef, (snapshot) => {
        const sentList = document.getElementById('sentRequestsList');
        const badge = document.getElementById('sentBadge');
        
        sentList.innerHTML = '';
        
        if (!snapshot.exists()) {
            sentList.innerHTML = '<p class="empty-message">No sent requests</p>';
            badge.textContent = '0';
            return;
        }
        
        const allRequests = snapshot.val();
        const sentRequests = [];
        
        // Find requests sent by current user
        Object.entries(allRequests).forEach(([userId, userRequests]) => {
            Object.entries(userRequests).forEach(([requestId, request]) => {
                if (request.from === currentUser.uid) {
                    sentRequests.push({ userId, requestId, ...request });
                }
            });
        });
        
        if (sentRequests.length === 0) {
            sentList.innerHTML = '<p class="empty-message">No sent requests</p>';
            badge.textContent = '0';
            return;
        }
        
        badge.textContent = sentRequests.length;
        
        sentRequests.forEach((request) => {
            const requestItem = document.createElement('div');
            requestItem.className = 'request-item';
            requestItem.innerHTML = `
                <div class="request-info">
                    <span class="request-username">@${escapeHtml(request.toUsername)}</span>
                    <span class="request-email">${escapeHtml(request.toEmail)}</span>
                </div>
                <div class="request-actions">
                    <button class="btn-cancel" data-user-id="${request.userId}" data-request-id="${request.requestId}">Cancel</button>
                </div>
            `;
            sentList.appendChild(requestItem);
        });
        
        // Add event listeners
        document.querySelectorAll('.btn-cancel').forEach(btn => {
            btn.addEventListener('click', (e) => {
                cancelRequest(e.target.dataset.userId, e.target.dataset.requestId);
            });
        });
    });
}

// Load contacts/friends
function loadContacts() {
    const friendsRef = ref(database, `friends/${currentUser.uid}`);
    
    onValue(friendsRef, (snapshot) => {
        const contactsList = document.getElementById('contactsList');
        const badge = document.getElementById('contactsBadge');
        
        contactsList.innerHTML = '';
        
        if (!snapshot.exists()) {
            contactsList.innerHTML = '<p class="empty-message">No contacts yet</p>';
            badge.textContent = '0';
            return;
        }
        
        const friends = snapshot.val();
        const friendsArray = Object.entries(friends);
        badge.textContent = friendsArray.length;
        
        friendsArray.forEach(([friendId, friend]) => {
            const contactItem = document.createElement('div');
            contactItem.className = 'contact-item';
            contactItem.innerHTML = `
                <div class="contact-info">
                    <span class="contact-username">@${escapeHtml(friend.username)}</span>
                    <span class="contact-email">${escapeHtml(friend.email)}</span>
                </div>
                <div class="request-actions">
                    <button class="btn-remove" data-friend-id="${friendId}">Remove</button>
                </div>
            `;
            contactsList.appendChild(contactItem);
        });
        
        // Add event listeners
        document.querySelectorAll('.btn-remove').forEach(btn => {
            btn.addEventListener('click', (e) => {
                if (confirm('Are you sure you want to remove this contact?')) {
                    removeFriend(e.target.dataset.friendId);
                }
            });
        });
    });
}

// Accept friend request
async function acceptRequest(requestId, request) {
    try {
        // Get current user's data from database to ensure we have the latest info
        const userRef = ref(database, `users/${currentUser.uid}`);
        const userSnapshot = await get(userRef);
        const currentUserData = userSnapshot.val();
        
        // Add to both users' friends lists
        // Add sender to current user's friends
        await set(ref(database, `friends/${currentUser.uid}/${request.from}`), {
            userId: request.from,
            username: request.fromUsername,
            email: request.fromEmail,
            addedAt: Date.now()
        });
        
        // Add current user to sender's friends
        await set(ref(database, `friends/${request.from}/${currentUser.uid}`), {
            userId: currentUser.uid,
            username: currentUserData.username,
            email: currentUserData.email,
            addedAt: Date.now()
        });
        
        // Remove the request
        await remove(ref(database, `friendRequests/${currentUser.uid}/${requestId}`));
        
    } catch (error) {
        console.error('Error accepting request:', error);
        alert('Failed to accept request. Please try again.');
    }
}

// Reject friend request
async function rejectRequest(requestId) {
    try {
        await remove(ref(database, `friendRequests/${currentUser.uid}/${requestId}`));
    } catch (error) {
        console.error('Error rejecting request:', error);
        alert('Failed to reject request. Please try again.');
    }
}

// Cancel sent request
async function cancelRequest(userId, requestId) {
    try {
        await remove(ref(database, `friendRequests/${userId}/${requestId}`));
    } catch (error) {
        console.error('Error canceling request:', error);
        alert('Failed to cancel request. Please try again.');
    }
}

// Remove friend
async function removeFriend(friendId) {
    try {
        await remove(ref(database, `friends/${currentUser.uid}/${friendId}`));
        await remove(ref(database, `friends/${friendId}/${currentUser.uid}`));
    } catch (error) {
        console.error('Error removing friend:', error);
        alert('Failed to remove contact. Please try again.');
    }
}

// Escape HTML
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}
