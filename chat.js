import { auth, database } from './firebase-config.js';
import { 
    onAuthStateChanged,
    signOut
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { 
    ref, 
    push, 
    onChildAdded,
    onChildRemoved,
    serverTimestamp,
    query,
    orderByChild,
    limitToLast,
    get,
    onValue,
    onDisconnect,
    remove,
    set,
    update,
    off
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";
import { uploadImageToS3WithSDK } from './s3-config.js';

let currentUser = null;
let currentUsername = null;
let currentUserData = null;
let friendsList = {};
let activeChat = null; // Currently selected contact
let messagesListener = null;
let messagesRemoveListener = null;
let profileListeners = {}; // Track profile picture listeners for each friend
let presenceListeners = {}; // Track last seen/online listeners for each friend
let globalMessageListeners = {}; // listeners for new messages across all chats
let lastKnownMessageId = {}; // track last seen message id per friend to avoid initial triggers
let selectedImageFile = null;
let initialLoadedMessages = {}; // map chatRoomId -> Set of messageIds loaded during initial fetch
let selectedProfilePicture = null;
let typingListener = null; // listener to typing nodes for active chat
let typingTimeout = null; // debounce timeout for local typing
let isTypingLocal = false; // local state if user is typing
// Incoming message audio (expects `newinchat.mp3` at app root). Preload for immediate play.
let incomingAudio = null;

// VAPID public key for Push API (provided by user)
// Generated externally. This public key pairs with the server private key below (kept secret server-side).
const VAPID_PUBLIC_KEY = 'BOvlFaMCX3DrMrF0KnoafL8ZcEhSxvfCk_lrlIHG8OsDv2K5VKHs7G9XQhZx0mhtMI2gkGogwzbMbiT0UnDL3LI'; // base64-url string

// Notification sound settings are persisted in localStorage under:
// - 'notifSoundChoice' => 'mute' | 'default' | 'custom'
// - 'notifSoundCustom' => data URL of chosen custom audio (optional)
function loadNotificationSettings() {
    const choice = localStorage.getItem('notifSoundChoice') || 'default';
    const customData = localStorage.getItem('notifSoundCustom') || null;
    return { choice, customData };
}

function saveNotificationChoice(choice) {
    localStorage.setItem('notifSoundChoice', choice);
}

function saveCustomNotificationData(dataUrl) {
    try { localStorage.setItem('notifSoundCustom', dataUrl); } catch (e) { console.warn('Failed to save custom sound to localStorage', e); }
}

function applyNotificationSoundSetting() {
    const { choice, customData } = loadNotificationSettings();
    try {
        if (choice === 'mute') {
            incomingAudio = null;
            return;
        }
        if (choice === 'custom' && customData) {
            incomingAudio = new Audio(customData);
            incomingAudio.preload = 'auto';
            incomingAudio.volume = 0.95;
            return;
        }
        // default fallback
        incomingAudio = new Audio('newinchat.mp3');
        incomingAudio.preload = 'auto';
        incomingAudio.volume = 0.9;
    } catch (err) {
        console.warn('Failed to initialize incoming audio:', err);
        incomingAudio = null;
    }
}

// Build small UI inside the settings menu to choose notification tone
function setupNotificationSettingsUI() {
    const menu = document.getElementById('settingsMenu');
    if (!menu) return;

    // Avoid duplicating UI
    if (document.getElementById('notifSettings')) return;

    const wrapper = document.createElement('div');
    wrapper.id = 'notifSettings';
    wrapper.style.padding = '10px 14px';
    wrapper.innerHTML = `
        <div class="notif-header">Notifications</div>
        <label class="notif-option">
            <input type="radio" name="notif-choice" value="mute">
            <span class="radio-faux"></span>
            <div class="notif-text">
                <div class="notif-title">Mute</div>
                <div class="notif-desc">No sounds or popups</div>
            </div>
        </label>
        <label class="notif-option">
            <input type="radio" name="notif-choice" value="default">
            <span class="radio-faux"></span>
            <div class="notif-text">
                <div class="notif-title">Default sound</div>
                <div class="notif-desc">Use the app's default tone</div>
            </div>
        </label>
        <label class="notif-option">
            <input type="radio" name="notif-choice" value="custom">
            <span class="radio-faux"></span>
            <div class="notif-text">
                <div class="notif-title">Custom file</div>
                <div class="notif-desc">Use a custom sound (no file chooser here)</div>
            </div>
        </label>
        <div style="margin-top:8px;">
            <span id="notifFileName"></span>
        </div>
        <div style="margin-top:10px; border-top:1px solid rgba(15,23,36,0.04); padding-top:10px;">
            <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
                <input type="checkbox" id="notifDesktopToggle">
                <div style="display:flex; flex-direction:column;">
                    <div style="font-weight:700;">Desktop notifications</div>
                    <div style="font-size:0.85rem; color:#5b6470;">Show OS-level notifications when the app is not focused</div>
                </div>
            </label>
            <div style="margin-top:8px; display:flex; gap:8px; align-items:center;">
                <button id="requestNotifPermissionBtn" class="btn-settings" style="display:none;">Enable desktop notifications</button>
                <button id="testNotifBtn" class="btn-settings">Send test notification</button>
                <button id="installAppBtn" class="btn-settings" style="display:none;">Install app</button>
            </div>
            <div style="margin-top:8px; color:#6b7280; font-size:0.88rem;">
                Note: The browser and OS control the top-line branding and origin shown on notifications. To have notifications appear with your app's icon/name instead of the browser, install this app as a PWA (use the "Install app" button if available).
            </div>
        </div>
    `;

    menu.appendChild(wrapper);

    const radios = wrapper.querySelectorAll('input[name="notif-choice"]');
    const fileNameSpan = wrapper.querySelector('#notifFileName');
    // Create hidden file input for custom selection (triggered when user chooses 'custom')
    let fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'audio/*';
    fileInput.style.display = 'none';
    fileInput.id = 'notifCustomFile';
    wrapper.appendChild(fileInput);

    fileInput.addEventListener('change', (e) => {
        const f = e.target.files[0];
        if (!f) return;
        if (!f.type.startsWith('audio/')) { alert('Please choose an audio file'); return; }
        if (f.size > 6 * 1024 * 1024) { alert('File too large (max 6MB)'); return; }
        const reader = new FileReader();
        reader.onload = (ev) => {
            const dataUrl = ev.target.result;
            saveCustomNotificationData(dataUrl);
            saveNotificationChoice('custom');
            // update UI
            radios.forEach(r => { r.checked = (r.value === 'custom'); });
            if (fileNameSpan) fileNameSpan.textContent = f.name;
            applyNotificationSoundSetting();
        };
        reader.readAsDataURL(f);
    });

    // Load current settings to UI
    const { choice, customData } = loadNotificationSettings();
    radios.forEach(r => { if (r.value === choice) r.checked = true; });
    if (customData && fileNameSpan) {
        fileNameSpan.textContent = 'Custom sound selected';
    }

    // Desktop notifications toggle
    const desktopToggle = wrapper.querySelector('#notifDesktopToggle');
    const permissionBtn = wrapper.querySelector('#requestNotifPermissionBtn');
    const testBtn = wrapper.querySelector('#testNotifBtn');
    const installBtn = wrapper.querySelector('#installAppBtn');
    function loadDesktopToggle() {
        const enabled = localStorage.getItem('notifDesktopEnabled') === 'true';
        // If browser already granted permission, prefer enabling desktop notifications by default
        const permGranted = (typeof Notification !== 'undefined' && Notification.permission === 'granted');
        if (permGranted && localStorage.getItem('notifDesktopEnabled') !== 'true') {
            localStorage.setItem('notifDesktopEnabled', 'true');
        }
        const finalEnabled = permGranted || enabled;
        desktopToggle.checked = !!finalEnabled;
        // Show request button if user checked but permission not granted
        if (desktopToggle.checked && (typeof Notification !== 'undefined') && Notification.permission !== 'granted') {
            permissionBtn.style.display = 'inline-block';
        } else {
            permissionBtn.style.display = 'none';
        }
    }
    loadDesktopToggle();

    desktopToggle.addEventListener('change', (e) => {
        const en = !!e.target.checked;
        localStorage.setItem('notifDesktopEnabled', en ? 'true' : 'false');
        if (en) {
            // If enabling, request permission if not already granted/denied
            if (typeof Notification === 'undefined') {
                alert('Notifications are not available in this browser.');
                permissionBtn.style.display = 'none';
            } else if (Notification.permission === 'granted') {
                permissionBtn.style.display = 'none';
            } else if (Notification.permission === 'denied') {
                alert('Notifications are blocked in your browser settings. Please enable them to receive desktop notifications.');
                permissionBtn.style.display = 'none';
            } else {
                // permission === 'default' -> request immediately for convenience
                try {
                    Notification.requestPermission().then(perm => {
                        if (perm === 'granted') {
                            permissionBtn.style.display = 'none';
                            alert('Desktop notifications enabled');
                        } else if (perm === 'denied') {
                            alert('Notifications blocked. You can re-enable them in your browser settings.');
                        }
                    }).catch(err => { console.debug('requestPermission error', err); });
                } catch (err) {
                    console.debug('requestPermission threw', err);
                }
            }
        } else {
            permissionBtn.style.display = 'none';
        }
    });

    // Push subscription controls (background notifications when app closed)
    // Add a checkbox and subscribe/unsubscribe button
    let pushControlRow = document.createElement('div');
    pushControlRow.style.marginTop = '10px';
    pushControlRow.style.display = 'flex';
    pushControlRow.style.gap = '8px';
    pushControlRow.style.alignItems = 'center';

    const pushLabel = document.createElement('label');
    pushLabel.style.display = 'flex';
    pushLabel.style.alignItems = 'center';
    pushLabel.style.gap = '8px';
    pushLabel.style.cursor = 'pointer';
    pushLabel.innerHTML = '<input type="checkbox" id="notifPushToggle"> <div style="display:flex; flex-direction:column;"><div style="font-weight:700;">Background push (works when app closed)</div><div style="font-size:0.85rem; color:#5b6470;">Requires a server to send push messages (VAPID)</div></div>';
    pushControlRow.appendChild(pushLabel);

    const pushBtn = document.createElement('button');
    pushBtn.className = 'btn-settings';
    pushBtn.id = 'notifPushBtn';
    pushBtn.textContent = 'Subscribe';
    pushControlRow.appendChild(pushBtn);

    wrapper.appendChild(pushControlRow);

    const pushToggle = wrapper.querySelector('#notifPushToggle');

    // Helper: convert base64 public key to Uint8Array
    function urlBase64ToUint8Array(base64String) {
        const padding = '='.repeat((4 - base64String.length % 4) % 4);
        const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
        const rawData = window.atob(base64);
        const outputArray = new Uint8Array(rawData.length);
        for (let i = 0; i < rawData.length; ++i) {
            outputArray[i] = rawData.charCodeAt(i);
        }
        return outputArray;
    }

    // Save subscription to Firebase under users/<uid>/pushSubscription
    async function saveSubscriptionToDb(sub) {
        if (!currentUser || !sub) return;
        try {
            const subJson = sub.toJSON ? sub.toJSON() : sub;
            const userSubRef = ref(database, `users/${currentUser.uid}/pushSubscription`);
            await set(userSubRef, subJson);
            console.debug('Saved push subscription to DB');
        } catch (err) {
            console.error('Failed to save subscription to DB', err);
        }
    }

    async function removeSubscriptionFromDb() {
        if (!currentUser) return;
        try {
            const userSubRef = ref(database, `users/${currentUser.uid}/pushSubscription`);
            await remove(userSubRef);
        } catch (err) {
            console.error('Failed to remove subscription from DB', err);
        }
    }

    async function subscribeToPush() {
        try {
            if (!('serviceWorker' in navigator)) return alert('Service worker not supported');
            if (!('PushManager' in window)) return alert('Push not supported in this browser');
            if (!VAPID_PUBLIC_KEY || VAPID_PUBLIC_KEY.includes('<YOUR_PUBLIC_VAPID_KEY')) return alert('Missing VAPID public key. Generate VAPID keys and paste the public key in `chat.js`.');

            const reg = await navigator.serviceWorker.ready;
            const sub = await reg.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
            });
            await saveSubscriptionToDb(sub);
            alert('Subscribed to push notifications');
            updatePushUiState(true);
        } catch (err) {
            console.error('subscribeToPush error', err);
            alert('Failed to subscribe to push: ' + (err && err.message));
        }
    }

    async function unsubscribeFromPush() {
        try {
            const reg = await navigator.serviceWorker.ready;
            const subscription = await reg.pushManager.getSubscription();
            if (subscription) {
                await subscription.unsubscribe();
                await removeSubscriptionFromDb();
            }
            alert('Unsubscribed from push notifications');
            updatePushUiState(false);
        } catch (err) {
            console.error('unsubscribeFromPush error', err);
            alert('Failed to unsubscribe: ' + (err && err.message));
        }
    }

    async function updatePushUiState(assumeSubscribed) {
        try {
            let subscribed = false;
            if ('serviceWorker' in navigator && 'PushManager' in window) {
                const reg = await navigator.serviceWorker.ready;
                const s = await reg.pushManager.getSubscription();
                subscribed = !!s || !!assumeSubscribed;
            }
            pushToggle.checked = subscribed;
            pushBtn.textContent = subscribed ? 'Unsubscribe' : 'Subscribe';
        } catch (err) { console.debug('updatePushUiState error', err); }
    }

    pushBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        if (!currentUser) return alert('Sign in to enable push notifications');
        try {
            const reg = await navigator.serviceWorker.ready;
            const existing = await reg.pushManager.getSubscription();
            if (existing) {
                // Unsubscribe
                await unsubscribeFromPush();
            } else {
                // Request notification permission first
                const perm = await Notification.requestPermission();
                if (perm !== 'granted') return alert('You must allow notifications to subscribe');
                await subscribeToPush();
            }
        } catch (err) { console.error('pushBtn click error', err); }
    });

    // initialize push UI state
    try { updatePushUiState(false); } catch (e) {}

    // Fullscreen button for phones
    const fsRow = document.createElement('div');
    fsRow.style.marginTop = '10px';
    const fsBtn = document.createElement('button');
    fsBtn.className = 'btn-settings';
    fsBtn.textContent = 'Enter Fullscreen (mobile)';
    fsRow.appendChild(fsBtn);
    wrapper.appendChild(fsRow);

    fsBtn.addEventListener('click', async () => {
        try {
            if (document.fullscreenElement) {
                await document.exitFullscreen();
            } else {
                await document.documentElement.requestFullscreen();
            }
        } catch (err) { console.debug('fullscreen error', err); alert('Fullscreen request failed'); }
    });

    permissionBtn.addEventListener('click', async () => {
        try {
            if (typeof Notification === 'undefined') return alert('Notifications are not available in this browser');
            const perm = await Notification.requestPermission();
            if (perm === 'granted') {
                permissionBtn.style.display = 'none';
                alert('Desktop notifications enabled');
            } else if (perm === 'denied') {
                alert('Notifications blocked. You can re-enable them in your browser settings.');
            }
        } catch (err) {
            console.debug('Notification permission error', err);
        }
    });

    // Test notification button: sends a sample notification to preview appearance
    testBtn.addEventListener('click', (e) => {
        e.preventDefault();
        try {
            if (typeof Notification === 'undefined') return alert('Notifications not available in this browser');
            if (Notification.permission !== 'granted') {
                Notification.requestPermission().then(perm => {
                    if (perm === 'granted') {
                        // show a test notif
                        const sample = { text: 'This is a test notification', sender: currentUsername || 'Test', type: 'text' };
                        showDesktopNotification(sample, currentUser && currentUser.uid);
                    } else {
                        alert('Permission not granted');
                    }
                });
            } else {
                const sample = { text: 'This is a test notification', sender: currentUsername || 'Test', type: 'text' };
                showDesktopNotification(sample, currentUser && currentUser.uid);
            }
        } catch (err) { console.debug('test notification error', err); alert('Failed to show test notification'); }
    });

    // Support for prompting PWA installation (beforeinstallprompt)
    let deferredInstallPrompt = null;
    window.addEventListener('beforeinstallprompt', (evt) => {
        // Prevent the mini-infobar from appearing on mobile
        evt.preventDefault();
        deferredInstallPrompt = evt;
        // show install button in settings
        try { installBtn.style.display = 'inline-block'; } catch (e) {}
    });

    installBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        if (!deferredInstallPrompt) {
            alert('Install prompt not available. You can install from your browser menu.');
            return;
        }
        deferredInstallPrompt.prompt();
        const choiceResult = await deferredInstallPrompt.userChoice;
        if (choiceResult.outcome === 'accepted') {
            installBtn.style.display = 'none';
            deferredInstallPrompt = null;
        } else {
            // user dismissed
        }
    });

    radios.forEach(r => r.addEventListener('change', (e) => {
        const val = e.target.value;
        saveNotificationChoice(val);
        if (val !== 'custom') {
            applyNotificationSoundSetting();
            if (fileNameSpan) fileNameSpan.textContent = (val === 'mute') ? 'Muted' : 'Using default';
        } else {
            // Custom selected — open file picker so user can choose a file
            try { fileInput.click(); } catch (err) { console.debug('File picker error', err); }
            if (fileNameSpan) fileNameSpan.textContent = 'Choose a file...';
        }
    }));
}

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
        
        currentUserData = snapshot.val();
        currentUsername = currentUserData.username;
        document.getElementById('userUsername').textContent = `@${currentUsername}`;
        
        // Update header avatar
        const headerAvatar = document.getElementById('headerAvatar');
        const headerAvatarInitial = document.getElementById('headerAvatarInitial');
        if (currentUserData.profilePicture) {
            headerAvatar.style.backgroundImage = `url(${currentUserData.profilePicture})`;
            headerAvatar.style.backgroundSize = 'cover';
            headerAvatar.style.backgroundPosition = 'center';
            headerAvatarInitial.style.display = 'none';
        } else {
            headerAvatarInitial.textContent = currentUsername.charAt(0).toUpperCase();
        }
        
        // Listen for profile picture changes
        const userProfileRef = ref(database, `users/${user.uid}/profilePicture`);
        onValue(userProfileRef, (snapshot) => {
            const profilePicture = snapshot.val();
            if (profilePicture) {
                headerAvatar.style.backgroundImage = `url(${profilePicture})`;
                headerAvatar.style.backgroundSize = 'cover';
                headerAvatar.style.backgroundPosition = 'center';
                headerAvatarInitial.style.display = 'none';
            }
        });
        
        // Load friends list and listen for changes
        // Setup presence handling for current user
        setupPresence();
        loadFriendsList();
    } else {
        // User is signed out, redirect to login
        window.location.href = 'index.html';
    }
});

// Setup presence for the signed in user
function setupPresence() {
    if (!currentUser) return;

    const connectedRef = ref(database, '.info/connected');
    const userOnlineRef = ref(database, `users/${currentUser.uid}/online`);
    const userLastSeenRef = ref(database, `users/${currentUser.uid}/lastSeen`);

    onValue(connectedRef, (snap) => {
        if (snap.exists() && snap.val() === true) {
            // When connected
            set(userOnlineRef, true);
            // Ensure we set lastSeen on disconnect
            onDisconnect(userOnlineRef).set(false);
            onDisconnect(userLastSeenRef).set(serverTimestamp());
        }
    });
}

// Settings menu toggle
document.getElementById('settingsBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = document.getElementById('settingsMenu');
    const btn = document.getElementById('settingsBtn');
    menu.classList.toggle('show');
    btn.classList.toggle('active');
});

// Close settings menu when clicking outside
document.addEventListener('click', (e) => {
    const menu = document.getElementById('settingsMenu');
    const btn = document.getElementById('settingsBtn');
    if (menu && menu.classList.contains('show') && !menu.contains(e.target) && e.target !== btn) {
        menu.classList.remove('show');
        btn.classList.remove('active');
    }
});

// Load saved gradient
function loadSavedGradient() {
    const savedGradient = localStorage.getItem('userGradient');
    if (savedGradient) {
        applyGradient(savedGradient);
    }
}

// Apply gradient to all elements
function applyGradient(gradientColors) {
    const [color1, color2] = gradientColors.split(',');
    const gradient = `linear-gradient(135deg, #${color1} 0%, #${color2} 100%)`;
    
    // Update CSS custom property
    document.documentElement.style.setProperty('--primary-gradient', gradient);
    
    // Apply to all gradient elements
    const elements = document.querySelectorAll('.btn-primary, .current-avatar, .contact-item-avatar, .message.sent .message-content, .header-avatar');
    elements.forEach(el => {
        el.style.background = gradient;
    });
    
    // Save to localStorage
    localStorage.setItem('userGradient', gradientColors);
}

// Customize gradient button
document.getElementById('customizeGradientBtn').addEventListener('click', () => {
    document.getElementById('gradientModal').style.display = 'flex';
    document.getElementById('settingsMenu').classList.remove('show');
    document.getElementById('settingsBtn').classList.remove('active');
    
    // Highlight currently selected gradient
    const currentGradient = localStorage.getItem('userGradient') || '667eea,764ba2';
    document.querySelectorAll('.gradient-preset').forEach(preset => {
        if (preset.dataset.gradient === currentGradient) {
            preset.classList.add('selected');
        } else {
            preset.classList.remove('selected');
        }
    });
});

// Close gradient modal
document.getElementById('closeGradientModalBtn').addEventListener('click', () => {
    document.getElementById('gradientModal').style.display = 'none';
});

// Gradient preset selection
document.querySelectorAll('.gradient-preset').forEach(preset => {
    preset.addEventListener('click', () => {
        const gradientColors = preset.dataset.gradient;
        
        // Update selection
        document.querySelectorAll('.gradient-preset').forEach(p => p.classList.remove('selected'));
        preset.classList.add('selected');
        
        // Apply gradient
        applyGradient(gradientColors);
        
        // Close modal
        setTimeout(() => {
            document.getElementById('gradientModal').style.display = 'none';
        }, 300);
    });
});

// Custom color inputs
document.getElementById('color1').addEventListener('input', (e) => {
    updateCustomGradientPreview();
});

document.getElementById('color2').addEventListener('input', (e) => {
    updateCustomGradientPreview();
});

function updateCustomGradientPreview() {
    const color1 = document.getElementById('color1').value;
    const color2 = document.getElementById('color2').value;
    const gradient = `linear-gradient(135deg, ${color1} 0%, ${color2} 100%)`;
    document.getElementById('gradientPreview').style.background = gradient;
}

// Apply custom gradient
document.getElementById('applyCustomGradientBtn').addEventListener('click', () => {
    const color1 = document.getElementById('color1').value.replace('#', '');
    const color2 = document.getElementById('color2').value.replace('#', '');
    const gradientColors = `${color1},${color2}`;
    
    applyGradient(gradientColors);
    
    // Close modal
    setTimeout(() => {
        document.getElementById('gradientModal').style.display = 'none';
    }, 300);
});

// Load saved gradient on page load
loadSavedGradient();

// Show fullscreen contacts list
document.getElementById('showContactsListBtn').addEventListener('click', () => {
    showFullscreenContactsList();
});

// Back from contacts list
document.getElementById('backFromContactsBtn').addEventListener('click', () => {
    hideFullscreenContactsList();
});

// Add new contact button
document.getElementById('addNewContactBtn').addEventListener('click', () => {
    window.location.href = 'contacts.html';
});

// Header profile click to edit profile picture
document.getElementById('headerProfileBtn').addEventListener('click', () => {
    document.getElementById('profilePictureModal').style.display = 'flex';
    document.getElementById('currentProfileInitial').textContent = currentUsername.charAt(0).toUpperCase();
    
    // Show current profile picture if exists
    if (currentUserData && currentUserData.profilePicture) {
        const avatarDiv = document.getElementById('currentProfileAvatar');
        avatarDiv.style.backgroundImage = `url(${currentUserData.profilePicture})`;
        avatarDiv.style.backgroundSize = 'cover';
        avatarDiv.querySelector('span').style.display = 'none';
    }
});

// Add contacts button from empty state
document.getElementById('addContactsBtn').addEventListener('click', () => {
    window.location.href = 'contacts.html';
});

// Close profile modal
document.getElementById('closeProfileModalBtn').addEventListener('click', () => {
    document.getElementById('profilePictureModal').style.display = 'none';
    document.getElementById('profileImagePreview').style.display = 'none';
    selectedProfilePicture = null;
});

// Select profile picture
document.getElementById('selectProfilePictureBtn').addEventListener('click', () => {
    document.getElementById('profilePictureInput').click();
});

// Profile picture selection handler
document.getElementById('profilePictureInput').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    if (!file.type.startsWith('image/')) {
        alert('Please select an image file.');
        return;
    }
    
    if (file.size > 5 * 1024 * 1024) {
        alert('Image size must be less than 5MB.');
        return;
    }
    
    selectedProfilePicture = file;
    
    const reader = new FileReader();
    reader.onload = (e) => {
        document.getElementById('profilePreviewImage').src = e.target.result;
        document.getElementById('profileImagePreview').style.display = 'block';
    };
    reader.readAsDataURL(file);
});

// Upload profile picture
document.getElementById('uploadProfilePictureBtn').addEventListener('click', async () => {
    if (!selectedProfilePicture) return;
    
    try {
        // Mark chat list item sending state (show spinner)
        if (activeChat && activeChat.id) {
            updateSidebarSending(activeChat.id, true);
        }
        document.getElementById('profileImagePreview').style.display = 'none';
        document.getElementById('profileUploadProgress').style.display = 'block';
        
        // Upload to S3
        const imageUrl = await uploadImageToS3WithSDK(selectedProfilePicture);
        
        // Update user profile in database
        const userRef = ref(database, `users/${currentUser.uid}`);
        await update(userRef, {
            profilePicture: imageUrl
        });
        
        // Update local data
        currentUserData.profilePicture = imageUrl;
        
        // Close modal
        selectedProfilePicture = null;
        document.getElementById('profilePictureInput').value = '';
        document.getElementById('profileUploadProgress').style.display = 'none';
        document.getElementById('profilePictureModal').style.display = 'none';
        
        alert('Profile picture updated!');
        
        // Reload friends list to update display
        loadFriendsList();
        
    } catch (error) {
        console.error('Error uploading profile picture:', error);
        alert('Failed to upload profile picture. Please try again.');
        document.getElementById('profileUploadProgress').style.display = 'none';
        document.getElementById('profileImagePreview').style.display = 'block';
    }
});

// Clear chat button
document.getElementById('clearChatBtn').addEventListener('click', async () => {
    if (!activeChat) return;
    
    if (!confirm('Are you sure you want to clear all messages in this chat? This cannot be undone.')) {
        return;
    }
    
    try {
        const chatRoomId = [currentUser.uid, activeChat.id].sort().join('_');
        const messagesRef = ref(database, `chatRooms/${chatRoomId}/messages`);
        const snapshot = await get(messagesRef);
        if (snapshot.exists()) {
            const messages = snapshot.val();
            const removePromises = [];
            for (const [msgId, msg] of Object.entries(messages)) {
                // only remove messages that were sent by the current user
                if (msg.senderId === currentUser.uid) {
                    const mRef = ref(database, `chatRooms/${chatRoomId}/messages/${msgId}`);
                    removePromises.push(remove(mRef));
                }
            }
            await Promise.all(removePromises);
        }
        // Remove any local placeholders (sending messages owned by current user)
        document.querySelectorAll('.message.own-message.sending').forEach(el => el.remove());
        // Clear local display if necessary (we don't remove other-user messages)
        // Optionally update the chat view and lists
        updateMainChatsList();
    } catch (error) {
        console.error('Error clearing chat:', error);
        alert('Failed to clear chat. Please try again.');
    }
});

// Logout functionality
document.getElementById('logoutBtn').addEventListener('click', async () => {
    try {
        // Update status to offline for current user
        if (currentUser) {
            await set(ref(database, `users/${currentUser.uid}/online`), false);
            await set(ref(database, `users/${currentUser.uid}/lastSeen`), serverTimestamp());
            // Remove typing flag if set
            if (activeChat) {
                const chatRoomId = [currentUser.uid, activeChat.id].sort().join('_');
                await remove(ref(database, `chatRooms/${chatRoomId}/typing/${currentUser.uid}`));
                // clear any sending spinner state
                updateSidebarSending(activeChat.id, false);
            }
        }
        await signOut(auth);
        // Redirect happens automatically through onAuthStateChanged
    } catch (error) {
        console.error('Logout error:', error);
        alert('Failed to logout. Please try again.');
    }
});

// Logout button in profile modal
document.getElementById('logoutBtnModal').addEventListener('click', async () => {
    try {
        if (currentUser) {
            await set(ref(database, `users/${currentUser.uid}/online`), false);
            await set(ref(database, `users/${currentUser.uid}/lastSeen`), serverTimestamp());
            if (activeChat) {
                const chatRoomId = [currentUser.uid, activeChat.id].sort().join('_');
                await remove(ref(database, `chatRooms/${chatRoomId}/typing/${currentUser.uid}`));
            }
        }
        await signOut(auth);
        // Redirect happens automatically through onAuthStateChanged
    } catch (error) {
        console.error('Logout error:', error);
        alert('Failed to logout. Please try again.');
    }
});

// Back to chats list button (mobile)
document.getElementById('backToContactsBtn').addEventListener('click', () => {
    // Hide active chat, show chats list
    document.getElementById('activeChat').style.display = 'none';
    document.getElementById('chatsListView').style.display = 'flex';
    
    // Clear active chat
    // Clear typing flag and sending spinner for current chat if necessary
    if (currentUser && activeChat) {
        const prevChatId = [currentUser.uid, activeChat.id].sort().join('_');
        setTypingFlag(prevChatId, false);
        updateSidebarSending(activeChat.id, false);
    }
    // Unsubscribe typing listener if present
    if (typingListener) {
        typingListener();
        typingListener = null;
    }
    // Clear local typing timeout
    if (typingTimeout) {
        clearTimeout(typingTimeout);
        typingTimeout = null;
    }
    activeChat = null;
    
    // Clear selected state
    document.querySelectorAll('.chat-list-item').forEach(item => {
        item.classList.remove('active');
    });
});

// Load friends list
async function loadFriendsList() {
    const friendsRef = ref(database, `friends/${currentUser.uid}`);
    
    onValue(friendsRef, async (snapshot) => {
        friendsList = {};
        
        // Clean up old profile listeners
        Object.values(profileListeners).forEach(unsubscribe => unsubscribe());
        profileListeners = {};
        
        if (!snapshot.exists()) {
            updateMainChatsList();
            updateFullscreenContactsList();
            return;
        }
        
        const friends = snapshot.val();
        
        // Fetch profile pictures for all friends and set up listeners
        for (const [friendId, friend] of Object.entries(friends)) {
            friendsList[friendId] = friend;
            
            // Get friend's profile picture
            const friendUserRef = ref(database, `users/${friendId}`);
            const friendSnapshot = await get(friendUserRef);
            if (friendSnapshot.exists()) {
                const friendData = friendSnapshot.val();
                friendsList[friendId].profilePicture = friendData.profilePicture;
            }
            
            // Set up real-time listener for profile picture changes
            setupProfileListener(friendId, friend.username);
        }
        
        // Update main chats list and fullscreen contacts
        updateMainChatsList();
        updateFullscreenContactsList();
        // Set up global message listeners so we can show notifications and live previews for messages in other chats
        setupGlobalMessageListeners();
    });
}

// Set up per-friend listeners to detect new messages in any chat (used for notifications and live preview)
function setupGlobalMessageListeners() {
    // Clean up listeners for friends no longer present
    Object.keys(globalMessageListeners).forEach(fid => {
        if (!friendsList[fid]) {
            try { globalMessageListeners[fid](); } catch (e) { /* ignore */ }
            delete globalMessageListeners[fid];
            // also remove any initialLoadedMessages set for that chatRoom
            try {
                const chatRoomId = [currentUser.uid, fid].sort().join('_');
                delete initialLoadedMessages[chatRoomId];
            } catch (e) { /* ignore */ }
        }
    });

    // Attach listeners for current friends
    for (const [friendId] of Object.entries(friendsList)) {
        if (globalMessageListeners[friendId]) continue; // already listening

        const chatRoomId = [currentUser.uid, friendId].sort().join('_');
        const messagesRef = ref(database, `chatRooms/${chatRoomId}/messages`);
        
        // Record current message ids so initial callbacks are ignored by onChildAdded
        initialLoadedMessages[chatRoomId] = initialLoadedMessages[chatRoomId] || new Set();
        get(messagesRef).then(snapshot => {
            if (snapshot.exists()) {
                snapshot.forEach(child => {
                    initialLoadedMessages[chatRoomId].add(child.key);
                });
            }

            // Attach listener for new child added (only truly new will be handled)
            globalMessageListeners[friendId] = onChildAdded(messagesRef, (snap) => {
                const key = snap.key;
                const msg = snap.val();
                const known = initialLoadedMessages[chatRoomId];
                if (known && known.has(key)) {
                    // remove from known so future additions aren't blocked
                    known.delete(key);
                    return;
                }
                // New message arrived
                handleNewMessageForFriend(friendId, msg, key);
            });
        }).catch(err => {
            console.error('Error initializing global message listener for', friendId, err);
            // still attach listener without initial suppression
            globalMessageListeners[friendId] = onChildAdded(messagesRef, (snap) => {
                handleNewMessageForFriend(friendId, snap.val(), snap.key);
            });
        });
    }
}

// Called when a new message arrives in any chat (via global listeners)
function handleNewMessageForFriend(friendId, message, messageId) {
    try {
        // If this message is for the active chat, skip — active chat has its own listener and UI will update there
        if (activeChat && activeChat.id === friendId) return;

        // Update chat list preview element live
        const chatListItem = document.querySelector(`.chat-list-item[data-friend-id="${friendId}"]`);
        if (chatListItem) {
            const msgEl = chatListItem.querySelector('.chat-list-message');
            if (msgEl) {
                let preview = 'No messages yet';
                if (message.type === 'image') preview = message.senderId === currentUser.uid ? 'You sent an image' : 'Sent an image';
                else preview = (message.senderId === currentUser.uid ? 'You: ' : '') + (message.text || '');
                msgEl.dataset.preview = preview;
                msgEl.textContent = preview;
            }

            // Update time display
            const timeEl = chatListItem.querySelector('.chat-list-time');
            if (timeEl) {
                let timeDisplay = '';
                if (message.timestamp) {
                    const messageDate = new Date(message.timestamp);
                    const now = new Date();
                    const diff = now - messageDate;
                    if (diff < 60000) timeDisplay = 'Now';
                    else if (diff < 3600000) timeDisplay = Math.floor(diff / 60000) + 'm';
                    else if (diff < 86400000) timeDisplay = Math.floor(diff / 3600000) + 'h';
                    else if (diff < 604800000) timeDisplay = Math.floor(diff / 86400000) + 'd';
                    else timeDisplay = messageDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                }
                timeEl.textContent = timeDisplay;
            }
        }

        // Play sound for incoming messages (not for our own messages)
        if (message.senderId !== currentUser.uid) {
            try {
                if (incomingAudio && document.visibilityState === 'visible') {
                    incomingAudio.currentTime = 0;
                    const p = incomingAudio.play();
                    if (p && typeof p.then === 'function') p.catch(() => {});
                }
            } catch (err) { console.debug('play audio error', err); }

            // Show on-screen toast notification
            showNewMessageNotification(message, friendId);

            // Show OS-level desktop notification when the page is not visible or window not focused
            try {
                    // Log and attempt desktop notification when allowed. Some environments (file://) or insecure origins block this.
                    console.debug('handleNewMessageForFriend: visibility=', document.visibilityState, 'hasFocus=', document.hasFocus());
                    if (isDesktopNotificationsEnabled() && (document.visibilityState !== 'visible' || !document.hasFocus())) {
                        showDesktopNotification(message, friendId);
                    } else {
                        // If user explicitly enabled desktop notifications and permissions are granted, still allow when visible
                        if (isDesktopNotificationsEnabled() && typeof Notification !== 'undefined' && Notification.permission === 'granted' && (document.visibilityState === 'visible' && !document.hasFocus())) {
                            showDesktopNotification(message, friendId);
                        }
                    }
            } catch (err) { console.debug('desktop notification error', err); }
        }

        // Optionally refresh chats list ordering or highlight — keep UI live by updating main list
        // A light-weight approach: move the chat-list-item to top
        if (chatListItem && chatListItem.parentNode) {
            const parent = chatListItem.parentNode;
            parent.insertBefore(chatListItem, parent.firstChild);
        } else {
            // As fallback, refresh the main list
            updateMainChatsList();
        }
    } catch (err) {
        console.error('Error handling live incoming message for friend', friendId, err);
    }
}

// Show fullscreen contacts list
function showFullscreenContactsList() {
    document.getElementById('fullscreenContactsList').classList.add('show');
}

// Hide fullscreen contacts list
function hideFullscreenContactsList() {
    document.getElementById('fullscreenContactsList').classList.remove('show');
}

// Update fullscreen contacts list
function updateFullscreenContactsList() {
    const contactsScroll = document.getElementById('fullscreenContactsScroll');
    
    if (Object.keys(friendsList).length === 0) {
        contactsScroll.innerHTML = '<p class="empty-message">No contacts yet. Add some friends!</p>';
        return;
    }
    
    // Sort contacts alphabetically
    const sortedContacts = Object.entries(friendsList).sort((a, b) => {
        return a[1].username.localeCompare(b[1].username);
    });
    
    contactsScroll.innerHTML = '';
    
    sortedContacts.forEach(([friendId, friend]) => {
        const contactItem = document.createElement('div');
        contactItem.className = 'fullscreen-contact-item';
        
        let avatarHTML = '';
        if (friend.profilePicture) {
            avatarHTML = `<div class="fullscreen-contact-avatar" style="background-image: url('${friend.profilePicture}'); background-size: cover; background-position: center;"></div>`;
        } else {
            avatarHTML = `<div class="fullscreen-contact-avatar">${friend.username.charAt(0).toUpperCase()}</div>`;
        }
        
        contactItem.innerHTML = `
            ${avatarHTML}
            <div class="fullscreen-contact-info">
                <div class="fullscreen-contact-name">@${escapeHtml(friend.username)}</div>
            </div>
        `;
        
        contactItem.addEventListener('click', () => {
            hideFullscreenContactsList();
            selectContact(friendId, friend);
        });
        
        contactsScroll.appendChild(contactItem);
    });
}

// Update the main chats list view
async function updateMainChatsList() {
    const chatsListContainer = document.getElementById('chatsListContainer');
    
    if (Object.keys(friendsList).length === 0) {
        chatsListContainer.innerHTML = `
            <div class="no-chats-message">
                <svg width="80" height="80" viewBox="0 0 24 24" fill="none" stroke="#999" stroke-width="1.5">
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
                </svg>
                <p>No messages yet</p>
                <button id="addContactsBtn" class="btn-primary">Add Contacts</button>
            </div>
        `;
        document.getElementById('addContactsBtn').addEventListener('click', () => {
            window.location.href = 'contacts.html';
        });
        return;
    }
    
    // Get last message for each friend
    const chatsData = [];
    for (const [friendId, friend] of Object.entries(friendsList)) {
        const chatRoomId = [currentUser.uid, friendId].sort().join('_');
        const messagesRef = ref(database, `chatRooms/${chatRoomId}/messages`);
        
        let lastMessage = null;
        let lastMessageTime = null;
        
        try {
            const messagesSnapshot = await get(messagesRef);
            
            if (messagesSnapshot.exists()) {
                const messages = messagesSnapshot.val();
                // Convert to array and sort by timestamp to get the last message
                const messagesArray = Object.entries(messages).map(([id, msg]) => ({
                    id,
                    ...msg
                }));
                
                // Sort by timestamp (most recent first)
                messagesArray.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
                
                if (messagesArray.length > 0) {
                    lastMessage = messagesArray[0];
                    lastMessageTime = lastMessage.timestamp;
                }
            }
        } catch (error) {
            console.error(`Error fetching messages for ${friendId}:`, error);
            // Continue with no last message for this friend
        }
        
        chatsData.push({
            friendId,
            friend,
            lastMessage,
            lastMessageTime: lastMessageTime || 0
        });
    }
    
    // Sort by last message time
    chatsData.sort((a, b) => b.lastMessageTime - a.lastMessageTime);
    
    // Render chats list
    chatsListContainer.innerHTML = '';
    chatsData.forEach(chat => {
        renderChatListItem(chat.friendId, chat.friend, chat.lastMessage);
    });
}

// Render a chat list item
function renderChatListItem(friendId, friend, lastMessage) {
    const chatsListContainer = document.getElementById('chatsListContainer');
    const chatItem = document.createElement('div');
    chatItem.className = 'chat-list-item';
    chatItem.dataset.friendId = friendId;
    
    // Avatar
    let avatarHTML = '';
    if (friend.profilePicture) {
        avatarHTML = `<div class="chat-list-avatar" style="background-image: url('${friend.profilePicture}'); background-size: cover; background-position: center;"></div>`;
    } else {
        avatarHTML = `<div class="chat-list-avatar"><span>${friend.username.charAt(0).toUpperCase()}</span></div>`;
    }
    
    // Last message preview
    let messagePreview = 'No messages yet';
    let timeDisplay = '';
    
    if (lastMessage) {
        if (lastMessage.imageUrl) {
            messagePreview = lastMessage.senderId === currentUser.uid ? 'You sent an image' : 'Sent an image';
        } else {
            const prefix = lastMessage.senderId === currentUser.uid ? 'You: ' : '';
            messagePreview = prefix + (lastMessage.text || '');
        }
        
        // Format time
        const messageDate = new Date(lastMessage.timestamp);
        const now = new Date();
        const diff = now - messageDate;
        
        if (diff < 60000) {
            timeDisplay = 'Now';
        } else if (diff < 3600000) {
            timeDisplay = Math.floor(diff / 60000) + 'm';
        } else if (diff < 86400000) {
            timeDisplay = Math.floor(diff / 3600000) + 'h';
        } else if (diff < 604800000) {
            timeDisplay = Math.floor(diff / 86400000) + 'd';
        } else {
            timeDisplay = messageDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        }
    }
    
    const onlineClass = friend && friend.online ? 'online' : '';
    chatItem.innerHTML = `
        ${avatarHTML}
        <div class="chat-list-content">
            <div class="chat-list-top">
                <div class="chat-list-name">@${escapeHtml(friend.username)} <span class="chat-list-status ${onlineClass}"></span></div>
                <div class="chat-list-time">${timeDisplay}</div>
            </div>
            <div class="chat-list-message">${escapeHtml(messagePreview)}</div>
        </div>
    `;
    
    chatItem.addEventListener('click', () => selectContact(friendId, friend));
    chatsListContainer.appendChild(chatItem);
    // Set initial presence status based on friendsList if available
    updateSidebarStatus(friendId, friendsList[friendId] && friendsList[friendId].online, friendsList[friendId] && friendsList[friendId].lastSeen);
    // Cache original message preview so we can restore after typing stops
    const messageEl = chatItem.querySelector('.chat-list-message');
    if (messageEl) {
        messageEl.dataset.preview = messagePreview;
    }
}

// Set up real-time listener for a friend's profile picture
function setupProfileListener(friendId, username) {
    const friendUserRef = ref(database, `users/${friendId}`);
    
    const unsubscribe = onValue(friendUserRef, (snapshot) => {
        if (snapshot.exists()) {
            const friendData = snapshot.val();
            const newProfilePicture = friendData.profilePicture;
            
            // Update in friendsList
            if (friendsList[friendId]) {
                friendsList[friendId].profilePicture = newProfilePicture;
                friendsList[friendId].online = !!friendData.online;
                friendsList[friendId].lastSeen = friendData.lastSeen;
            }
            
            // Update sidebar avatar
            updateSidebarAvatar(friendId, newProfilePicture, username);
            
            // Update active chat header if this is the current chat
            if (activeChat && activeChat.id === friendId) {
                updateActiveChatAvatar(newProfilePicture, username);
                updateActiveChatStatus(friendsList[friendId].online, friendsList[friendId].lastSeen);
            }
            // Update chat list item status indicator if present
            updateSidebarStatus(friendId, friendsList[friendId].online, friendsList[friendId].lastSeen);
        }
    });
    
    profileListeners[friendId] = unsubscribe;
}

// Render a contact in the sidebar
function renderSidebarContact(friendId, friend) {
    const sidebarList = document.getElementById('contactsSidebarList');
    const contactItem = document.createElement('div');
    contactItem.className = 'sidebar-contact-item';
    contactItem.dataset.friendId = friendId;
    
    let avatarHTML = '';
    if (friendsList[friendId].profilePicture) {
        avatarHTML = `<div class="avatar clickable-avatar" data-profile-pic="${friendsList[friendId].profilePicture}" data-username="${escapeHtml(friend.username)}" style="background-image: url('${friendsList[friendId].profilePicture}'); background-size: cover; background-position: center;"></div>`;
    } else {
        avatarHTML = `<div class="avatar"><span>${friend.username.charAt(0).toUpperCase()}</span></div>`;
    }
    
    const sidebarOnlineClass = friend && friend.online ? 'online' : '';
    contactItem.innerHTML = `
        ${avatarHTML}
        <div class="sidebar-contact-info">
            <div class="sidebar-contact-name">@${escapeHtml(friend.username)} <span class="sidebar-contact-status ${sidebarOnlineClass}"></span></div>
        </div>
    `;
    
    const avatarElement = contactItem.querySelector('.clickable-avatar');
    if (avatarElement) {
        avatarElement.addEventListener('click', (e) => {
            e.stopPropagation(); // Prevent selecting the contact
            openProfileModal(avatarElement.dataset.profilePic, avatarElement.dataset.username);
        });
    }

    // Set initial status for contact
    updateSidebarStatus(friendId, friendsList[friendId] && friendsList[friendId].online, friendsList[friendId] && friendsList[friendId].lastSeen);
    
    contactItem.addEventListener('click', () => selectContact(friendId, friend));
    sidebarList.appendChild(contactItem);
}

// Update sidebar avatar in real-time
function updateSidebarAvatar(friendId, profilePicture, username) {
    const contactItem = document.querySelector(`[data-friend-id="${friendId}"]`);
    if (!contactItem) return;
    
    const avatarDiv = contactItem.querySelector('.avatar');
    if (!avatarDiv) return;
    
    if (profilePicture) {
        avatarDiv.className = 'avatar clickable-avatar';
        avatarDiv.style.backgroundImage = `url('${profilePicture}')`;
        avatarDiv.style.backgroundSize = 'cover';
        avatarDiv.style.backgroundPosition = 'center';
        avatarDiv.innerHTML = '';
        avatarDiv.dataset.profilePic = profilePicture;
        avatarDiv.dataset.username = username;
        
        // Re-add click event
        avatarDiv.onclick = (e) => {
            e.stopPropagation();
            openProfileModal(profilePicture, username);
        };
    } else {
        avatarDiv.className = 'avatar';
        avatarDiv.style.backgroundImage = '';
        avatarDiv.innerHTML = `<span>${username.charAt(0).toUpperCase()}</span>`;
        delete avatarDiv.dataset.profilePic;
        delete avatarDiv.dataset.username;
        avatarDiv.onclick = null;
    }
}

// Update active chat avatar in real-time
function updateActiveChatAvatar(profilePicture, username) {
    const avatarDiv = document.getElementById('activeChatAvatar');
    const initialSpan = document.getElementById('activeChatInitial');
    
    if (!avatarDiv || !initialSpan) return;
    
    // Update activeChat object
    if (activeChat) {
        activeChat.profilePicture = profilePicture;
    }
    
    if (profilePicture) {
        avatarDiv.style.backgroundImage = `url('${profilePicture}')`;
        avatarDiv.style.backgroundSize = 'cover';
        avatarDiv.style.backgroundPosition = 'center';
        avatarDiv.style.cursor = 'pointer';
        initialSpan.style.display = 'none';
        
        // Update click event
        avatarDiv.onclick = () => openProfileModal(profilePicture, username);
    } else {
        avatarDiv.style.backgroundImage = '';
        avatarDiv.style.cursor = 'default';
        avatarDiv.onclick = null;
        initialSpan.style.display = 'flex';
        initialSpan.textContent = username.charAt(0).toUpperCase();
    }
}

// Select a contact to chat with
async function selectContact(friendId, friend) {
    // Clear typing flag and sending spinner on the previous active chat if present
    if (currentUser && activeChat) {
        const prevChatRoomId = [currentUser.uid, activeChat.id].sort().join('_');
        setTypingFlag(prevChatRoomId, false);
        updateSidebarSending(activeChat.id, false);
    }
    activeChat = { id: friendId, ...friend };
    
    // Get friend's current profile picture from friendsList (already updated by listener)
    if (friendsList[friendId]) {
        activeChat.profilePicture = friendsList[friendId].profilePicture;
    }
    
    // Update UI - hide chats list, show active chat
    document.getElementById('chatsListView').style.display = 'none';
    document.getElementById('activeChat').style.display = 'flex';
    
    // Update active chat header (profile will auto-update via listener)
    updateActiveChatAvatar(activeChat.profilePicture, friend.username);
    updateActiveChatStatus(friendsList[friendId] && friendsList[friendId].online, friendsList[friendId] && friendsList[friendId].lastSeen);
    document.getElementById('activeChatUsername').textContent = `@${friend.username}`;
    
    // Highlight selected contact in chats list
    document.querySelectorAll('.chat-list-item').forEach(item => {
        item.classList.remove('active');
    });
    const chatListItem = document.querySelector(`.chat-list-item[data-friend-id="${friendId}"]`);
    if (chatListItem) {
        chatListItem.classList.add('active');
    }
    
    // Clear previous messages
    document.getElementById('messagesList').innerHTML = '';
    
    // Load messages for this chat
    loadMessages(friendId);
    
    // Focus on input
    document.getElementById('messageInput').focus();
}

// Image button handler
document.getElementById('imageBtn').addEventListener('click', () => {
    document.getElementById('imageInput').click();
});

// Camera button handler - open camera modal and start stream
document.getElementById('cameraBtn').addEventListener('click', async () => {
    openCameraModal();
});

// Camera modal controls
let currentStream = null;
let currentFacing = 'environment';

async function openCameraModal() {
    const modal = document.getElementById('cameraModal');
    const video = document.getElementById('cameraVideo');
    modal.style.display = 'flex';
    try {
        const constraints = { video: { facingMode: currentFacing } };
        currentStream = await navigator.mediaDevices.getUserMedia(constraints);
        video.srcObject = currentStream;
    } catch (error) {
        console.error('Error opening camera:', error);
        alert('Failed to access camera. Please ensure you granted permission.');
        modal.style.display = 'none';
    }
}

async function closeCameraModal() {
    const modal = document.getElementById('cameraModal');
    const video = document.getElementById('cameraVideo');
    modal.style.display = 'none';
    if (currentStream) {
        currentStream.getTracks().forEach(t => t.stop());
        currentStream = null;
    }
    if (video) video.srcObject = null;
}

document.getElementById('closeCameraBtn').addEventListener('click', () => {
    closeCameraModal();
});

document.getElementById('flipCameraBtn').addEventListener('click', async () => {
    // Toggle facing mode and restart stream
    currentFacing = (currentFacing === 'environment') ? 'user' : 'environment';
    if (currentStream) {
        currentStream.getTracks().forEach(t => t.stop());
    }
    await openCameraModal();
});

// Capture photo button - draw frame to canvas, set selectedImageFile, show preview
document.getElementById('capturePhotoBtn').addEventListener('click', () => {
    const video = document.getElementById('cameraVideo');
    const canvas = document.getElementById('cameraCanvas');
    const modal = document.getElementById('cameraModal');
    const ctx = canvas.getContext('2d');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(async (blob) => {
        // Convert to File and set selectedImageFile
        const file = new File([blob], `camera-${Date.now()}.jpg`, { type: blob.type });
        selectedImageFile = file;
        // Set preview
        document.getElementById('previewImage').src = URL.createObjectURL(blob);
        document.getElementById('imagePreview').style.display = 'block';
        document.getElementById('messageForm').style.display = 'none';
        // Close modal and stop stream
        closeCameraModal();
    }, 'image/jpeg', 0.9);
});

// Image selection handler
document.getElementById('imageInput').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    // Validate file type
    if (!file.type.startsWith('image/')) {
        alert('Please select an image file.');
        return;
    }
    
    // Validate file size (max 5MB)
    if (file.size > 5 * 1024 * 1024) {
        alert('Image size must be less than 5MB.');
        return;
    }
    
    selectedImageFile = file;
    
    // Show preview
    const reader = new FileReader();
    reader.onload = (e) => {
        document.getElementById('previewImage').src = e.target.result;
        document.getElementById('imagePreview').style.display = 'block';
        document.getElementById('messageForm').style.display = 'none';
    };
    reader.readAsDataURL(file);
});

// Cancel image selection
document.getElementById('cancelImageBtn').addEventListener('click', () => {
    selectedImageFile = null;
    document.getElementById('imageInput').value = '';
    document.getElementById('imagePreview').style.display = 'none';
    document.getElementById('messageForm').style.display = 'flex';
});

// Send image
document.getElementById('sendImageBtn').addEventListener('click', async () => {
    if (!selectedImageFile || !activeChat) return;
    
    // Create a temporary placeholder message bubble with spinner
    const tempId = 'temp-' + Date.now() + '-' + Math.random().toString(36).slice(2);
    const messagesList = document.getElementById('messagesList');
    const previewUrl = URL.createObjectURL(selectedImageFile);
    const tempDiv = document.createElement('div');
    tempDiv.className = 'message own-message sending';
    tempDiv.dataset.tempId = tempId;
    tempDiv.innerHTML = `
        <div class="message-header">
            <span class="message-time">Sending...</span>
        </div>
        <div class="message-image-container">
            <img src="${previewUrl}" class="message-image" alt="Sending image">
        </div>
    `;
    // Add centered spinner element so it remains perfectly centered as soon as the image has size
    const imgContainer = tempDiv.querySelector('.message-image-container');
    const spinnerEl = document.createElement('span');
    spinnerEl.className = 'sending-spinner';
    if (imgContainer) imgContainer.appendChild(spinnerEl);
    messagesList.appendChild(tempDiv);
    // Scroll to bottom
    const messagesContainer = document.getElementById('messagesContainer');
    messagesContainer.scrollTop = messagesContainer.scrollHeight;

    try {
        // Hide preview UI
        document.getElementById('imagePreview').style.display = 'none';
        // Upload to S3
        const imageUrl = await uploadImageToS3WithSDK(selectedImageFile);

        // Send message with image
        const chatRoomId = [currentUser.uid, activeChat.id].sort().join('_');
        const messagesRef = ref(database, `chatRooms/${chatRoomId}/messages`);
        await push(messagesRef, {
            type: 'image',
            imageUrl: imageUrl,
            sender: currentUsername,
            senderEmail: currentUser.email,
            senderId: currentUser.uid,
            timestamp: serverTimestamp()
        });

        // Update main chats list
        updateMainChatsList();

        // Reset
        selectedImageFile = null;
        document.getElementById('imageInput').value = '';
        document.getElementById('messageForm').style.display = 'flex';

        // Remove temp placeholder
        if (tempDiv && tempDiv.parentNode) {
            tempDiv.remove();
        }
        // Remove chat-list sending spinner
        if (activeChat && activeChat.id) updateSidebarSending(activeChat.id, false);
        // Revoke object url to free memory
        try { URL.revokeObjectURL(previewUrl); } catch (e) { /* ignore */ }
    } catch (error) {
        console.error('Error uploading image:', error);
        alert('Failed to upload image. Please try again.');
        // show preview UI again
        document.getElementById('imagePreview').style.display = 'block';
        // mark placeholder as failed
        tempDiv.classList.remove('sending');
        // Remove chat-list sending spinner
        if (activeChat && activeChat.id) updateSidebarSending(activeChat.id, false);
        // Revoke preview url (free memory)
        try { URL.revokeObjectURL(previewUrl); } catch (e) { /* ignore */ }
        const errOverlay = document.createElement('div');
        errOverlay.className = 'message-send-error';
        errOverlay.textContent = 'Failed to send';
        tempDiv.appendChild(errOverlay);
    }
});

// Message Form Handler
document.getElementById('messageForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const messageInput = document.getElementById('messageInput');
    const messageText = messageInput.value.trim();
    
    if (!messageText || !currentUser || !activeChat) return;
    
    try {
        // Create a unique chat room ID (sorted user IDs)
        const chatRoomId = [currentUser.uid, activeChat.id].sort().join('_');
        
        const messagesRef = ref(database, `chatRooms/${chatRoomId}/messages`);
        await push(messagesRef, {
            type: 'text',
            text: messageText,
            sender: currentUsername,
            senderEmail: currentUser.email,
            senderId: currentUser.uid,
            timestamp: serverTimestamp()
        });
        
        // Update main chats list
        updateMainChatsList();
        
        messageInput.value = '';
        messageInput.focus();
        // After sending message, clear typing flag for this chat
        try {
            const chatRoomId = [currentUser.uid, activeChat.id].sort().join('_');
            await setTypingFlag(chatRoomId, false);
        } catch (err) {
            console.error('Error clearing typing flag on submit:', err);
        }
    } catch (error) {
        console.error('Error sending message:', error);
        alert('Failed to send message. Please try again.');
    }
});

// Load and listen for messages in the active chat
function loadMessages(friendId) {
    // Detach previous listeners if exist
    if (messagesListener) {
        messagesListener();
        messagesListener = null;
    }
    if (messagesRemoveListener) {
        messagesRemoveListener();
        messagesRemoveListener = null;
    }
    
    // Create a unique chat room ID (sorted user IDs)
    const chatRoomId = [currentUser.uid, friendId].sort().join('_');
    
    const messagesRef = ref(database, `chatRooms/${chatRoomId}/messages`);
    // Avoid using orderByChild queries which require .indexOn rules; fetch and sort locally instead
    // Track initial messages for this chat so the onChildAdded listener can ignore them
    initialLoadedMessages[chatRoomId] = new Set();

    // First fetch existing messages and render them without entry animation
    get(messagesRef).then((snapshot) => {
        const items = [];
        if (snapshot.exists()) {
            snapshot.forEach(child => {
                items.push({ id: child.key, val: child.val() });
            });
            // Sort by timestamp ascending so messages show oldest -> newest
            items.sort((a, b) => (a.val.timestamp || 0) - (b.val.timestamp || 0));
            // Keep only last 50 messages
            const recent = items.slice(-50);
            recent.forEach(item => {
                // remember id to ignore duplicate onChildAdded triggers
                initialLoadedMessages[chatRoomId].add(item.id);
                displayMessage(item.val, item.id, { suppressAnimation: true });
            });
        }
        // After initial load, scroll to bottom
        const messagesContainer = document.getElementById('messagesContainer');
        if (messagesContainer) messagesContainer.scrollTop = messagesContainer.scrollHeight;

        // Now attach the onChildAdded listener — attach after initial load to avoid treating existing messages as new
        messagesListener = onChildAdded(messagesRef, (snapshot) => {
            const message = snapshot.val();
            const messageId = snapshot.key;
            // If this message was part of the initial load, ignore it here
            const set = initialLoadedMessages[chatRoomId];
            if (set && set.has(messageId)) {
                // remove from set so future additions aren't affected
                set.delete(messageId);
                return;
            }
            // displayMessage for truly new messages
            displayMessage(message, messageId, { suppressAnimation: false });
        });
    }).catch(err => {
        console.error('Error loading initial messages:', err);
        // Fallback: attach listener even if initial fetch failed — but don't have initial IDs to ignore
        messagesListener = onChildAdded(messagesRef, (snapshot) => {
            const message = snapshot.val();
            const messageId = snapshot.key;
            displayMessage(message, messageId, { suppressAnimation: false });
        });
    });
    
    // Listen for deleted messages
    messagesRemoveListener = onChildRemoved(messagesRef, (snapshot) => {
        const messageId = snapshot.key;
        // Remove from DOM in real-time
        const messageElement = document.querySelector(`[data-message-id="${messageId}"]`);
        if (messageElement) {
            messageElement.remove();
        }
    });

    // Typing indicator listener - update indicator for other user's typing
    if (typingListener) {
        typingListener();
        typingListener = null;
    }
    const typingRef = ref(database, `chatRooms/${chatRoomId}/typing`);
    typingListener = onValue(typingRef, (snapshot) => {
        const data = snapshot.val();
        let otherTyping = false;
        if (data) {
            for (const uid in data) {
                if (uid !== currentUser.uid && data[uid]) {
                    otherTyping = true;
                    break;
                }
            }
        }
        updateTypingIndicator(otherTyping);
    });
}

// Delete a message
window.deleteMessage = async function(messageId) {
    if (!activeChat) return;
    
    if (!confirm('Delete this message?')) {
        return;
    }
    
    try {
        const chatRoomId = [currentUser.uid, activeChat.id].sort().join('_');
        const messageRef = ref(database, `chatRooms/${chatRoomId}/messages/${messageId}`);
        // Ensure the message belongs to the current user
        const messageSnap = await get(messageRef);
        if (!messageSnap.exists()) return;
        const messageData = messageSnap.val();
        if (messageData.senderId !== currentUser.uid) {
            alert('You can only delete your own messages.');
            return;
        }
        await remove(messageRef);
        
        // DOM removal handled automatically by onChildRemoved listener
        
    } catch (error) {
        console.error('Error deleting message:', error);
        alert('Failed to delete message. Please try again.');
    }
}

// Display a message in the chat
function displayMessage(message, messageId, options = {}) {
    const suppressAnimation = options.suppressAnimation || false;
    const messagesList = document.getElementById('messagesList');
    
    // Check if message already exists in DOM (prevent duplicates)
    if (document.querySelector(`[data-message-id="${messageId}"]`)) {
        return; // Message already displayed, skip
    }
    
    const messageDiv = document.createElement('div');
    
    // Check senderId (messages use senderId when saved to DB)
    const isOwnMessage = currentUser && message.senderId === currentUser.uid;
    messageDiv.className = `message ${isOwnMessage ? 'own-message' : 'other-message'}`;
    messageDiv.dataset.messageId = messageId;

    // If we want to suppress the default entry animation (e.g., initial load), add a helper class
    if (suppressAnimation) {
        messageDiv.classList.add('no-anim');
    }
    
    // Format timestamp
    let timeString = 'Just now';
    if (message.timestamp) {
        const date = new Date(message.timestamp);
        const now = new Date();
        const isToday = date.toDateString() === now.toDateString();
        
        if (isToday) {
            timeString = date.toLocaleTimeString('en-US', { 
                hour: 'numeric', 
                minute: '2-digit',
                hour12: true 
            });
        } else {
            timeString = date.toLocaleString('en-US', { 
                month: 'short', 
                day: 'numeric',
                hour: 'numeric', 
                minute: '2-digit',
                hour12: true 
            });
        }
    }
    
    // Determine content based on message type
    let contentHTML = '';
    if (message.type === 'image') {
        contentHTML = `
            <div class="message-image-container">
                <img src="${escapeHtml(message.imageUrl)}" alt="Shared image" class="message-image" onclick="openImageModal('${escapeHtml(message.imageUrl)}')">
            </div>
        `;
    } else {
        contentHTML = `
            <div class="message-content">
                ${escapeHtml(message.text)}
            </div>
        `;
    }
    
    // Add delete button for own messages
    let deleteButton = '';
    if (isOwnMessage) {
        deleteButton = `<button class="btn-delete-message" onclick="deleteMessage('${messageId}')" title="Delete message">×</button>`;
    }
    
    messageDiv.innerHTML = `
        <div class="message-header">
            <span class="message-sender">${escapeHtml(message.sender)}</span>
            <span class="message-time">${timeString}</span>
        </div>
        ${contentHTML}
        ${deleteButton}
    `;
    
    // If this is our own message, remove any local sending placeholder first
    if (isOwnMessage) {
        const placeholder = messagesList.querySelector('.message.own-message.sending');
        if (placeholder) placeholder.remove();
    }
    messagesList.appendChild(messageDiv);

    // Animate appropriately: own messages get the 'new-sent' pop, incoming messages get a slide-in from left
    if (isOwnMessage) {
        requestAnimationFrame(() => {
            messageDiv.classList.add('new-sent');
        });
        messageDiv.addEventListener('animationend', () => {
            messageDiv.classList.remove('new-sent');
        }, { once: true });
    } else {
        if (!suppressAnimation) {
            // Play incoming sound when receiving a new message in the active chat and the page is visible
            try {
                if (incomingAudio && activeChat && document.visibilityState === 'visible') {
                    try {
                        incomingAudio.currentTime = 0;
                        const p = incomingAudio.play();
                        if (p && typeof p.then === 'function') p.catch(() => { /* autoplay blocked or user hasn't interacted yet */ });
                    } catch (playErr) {
                        // Some browsers may throw synchronously
                        console.debug('Incoming audio play error:', playErr);
                    }
                }
            } catch (err) {
                console.debug('Error handling incoming audio:', err);
            }

            // If the user isn't looking at the page (or window not focused), show a desktop notification
            try {
                if (!isOwnMessage && isDesktopNotificationsEnabled() && (document.visibilityState !== 'visible' || !document.hasFocus())) {
                    // active chat still could trigger an OS notification if the user switched tabs
                    showDesktopNotification(message, activeChat && activeChat.id);
                }
            } catch (err) {
                console.debug('desktop notif (active chat) error', err);
            }

            // Only animate incoming messages when they are truly new (not part of initial load)
            requestAnimationFrame(() => {
                messageDiv.classList.add('attention-incoming');
            });

            // Pulse the active chat avatar to draw extra attention
            if (!isOwnMessage) {
                const activeAvatar = document.getElementById('activeChatAvatar');
                if (activeAvatar) {
                    activeAvatar.classList.add('avatar-pulse');
                    // Remove pulse after animation completes (with a safe fallback timeout)
                    const removePulse = () => { activeAvatar.classList.remove('avatar-pulse'); };
                    activeAvatar.addEventListener('animationend', removePulse, { once: true });
                    setTimeout(removePulse, 900);
                }
            }

            messageDiv.addEventListener('animationend', () => {
                messageDiv.classList.remove('attention-incoming');
            }, { once: true });
        }
    }
    
    // Scroll to bottom
    const messagesContainer = document.getElementById('messagesContainer');
    if (messagesContainer) messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

// Create and show a transient on-screen notification for incoming messages
function showNewMessageNotification(message, friendId) {
    try {
        const containerId = 'newMessageNotificationContainer';
        let container = document.getElementById(containerId);
        if (!container) {
            container = document.createElement('div');
            container.id = containerId;
            container.className = 'new-message-notification-container';
            document.body.appendChild(container);
        }

        const notif = document.createElement('div');
        notif.className = 'new-message-notification enter';

        // create thumbnail (avatar initial or image if available)
        const thumb = document.createElement('div');
        thumb.className = 'thumb';
        const friend = friendsList[friendId] || {};
        if (friend.profilePicture) {
            thumb.style.backgroundImage = `url('${friend.profilePicture}')`;
            thumb.style.backgroundSize = 'cover';
            thumb.style.backgroundPosition = 'center';
        } else {
            thumb.textContent = (friend.username && friend.username.charAt(0).toUpperCase()) || (message.sender && message.sender.charAt(0).toUpperCase()) || '?';
        }

        const content = document.createElement('div');
        content.className = 'content';
        const title = document.createElement('div');
        title.className = 'title';
        title.textContent = `@${friend.username || message.sender || 'Unknown'}`;
        const body = document.createElement('div');
        body.className = 'body';
        if (message.type === 'image') body.textContent = 'Sent an image';
        else body.textContent = message.text || '';

        const time = document.createElement('div');
        time.className = 'time';
        time.textContent = (new Date()).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

        const closeBtn = document.createElement('button');
        closeBtn.className = 'close-btn';
        closeBtn.title = 'Dismiss';
        closeBtn.innerHTML = '✕';

        // Click behavior: focus the chat (no-op if already visible), remove notification
        notif.addEventListener('click', (e) => {
            e.stopPropagation();
            // Bring focus to message input
            const messageInput = document.getElementById('messageInput');
            if (messageInput) messageInput.focus();
            // Remove notification
            if (notif && notif.parentNode) notif.parentNode.removeChild(notif);
        });
        closeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (notif && notif.parentNode) notif.parentNode.removeChild(notif);
        });

        content.appendChild(title);
        content.appendChild(body);

        notif.appendChild(thumb);
        notif.appendChild(content);
        notif.appendChild(time);
        notif.appendChild(closeBtn);

        container.appendChild(notif);

        // show animation
        requestAnimationFrame(() => {
            notif.classList.remove('enter');
            notif.classList.add('show');
        });

        // Auto-dismiss after 4.5s
        const timeout = setTimeout(() => {
            if (notif && notif.parentNode) {
                // fade out
                notif.classList.remove('show');
                setTimeout(() => { if (notif && notif.parentNode) notif.parentNode.removeChild(notif); }, 220);
            }
        }, 4500);

        // If clicked anywhere else on document, dismiss that specific notification
        const docClick = (e) => {
            if (!notif.contains(e.target)) {
                if (notif && notif.parentNode) notif.parentNode.removeChild(notif);
                document.removeEventListener('click', docClick);
                clearTimeout(timeout);
            }
        };
        document.addEventListener('click', docClick);

    } catch (err) {
        console.debug('Error showing notification:', err);
    }
}

// Desktop notification helpers
function isDesktopNotificationsEnabled() {
    return localStorage.getItem('notifDesktopEnabled') === 'true';
}

async function showDesktopNotification(message, friendId) {
    try {
        console.debug('Attempting desktop notification for', friendId, 'perm=', (typeof Notification !== 'undefined' ? Notification.permission : 'n/a'));
        if (typeof Notification === 'undefined') return;
        if (!isDesktopNotificationsEnabled()) return;
        if (Notification.permission !== 'granted') return;

        const friend = friendsList[friendId] || {};
        const title = `@${friend.username || message.sender || 'New message'}`;
        let body = '';
        if (message.type === 'image') body = 'Sent an image';
        else body = message.text || '';

        // Prefer using the friend's profile picture as the notification icon.
        // For image messages, include the message image where supported.
        const icon = (friend.profilePicture) ? friend.profilePicture : undefined;
        const image = (message.type === 'image' && message.imageUrl) ? message.imageUrl : undefined;
        const chatRoomId = [currentUser && currentUser.uid, friendId].filter(Boolean).sort().join('_') || undefined;

        // Small transparent badge to reduce default platform badge/logo prominence where supported.
        const transparentBadge = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAnsB9m3v4OgAAAAASUVORK5CYII=';

        const notifOptions = {
            body: body,
            icon: icon,
            image: image,
            badge: transparentBadge,
            tag: chatRoomId || undefined,
            renotify: true,
            silent: false,
            data: { chatRoomId, friendId }
        };

        const notif = new Notification(title, notifOptions);

        notif.onclick = (e) => {
            try {
                // Focus the window/tab and open the chat
                if (window.focus) window.focus();
                if (typeof selectContact === 'function') {
                    const friend = friendsList[friendId];
                    if (friend) selectContact(friendId, friend);
                }
                notif.close && notif.close();
            } catch (err) { console.debug('Notification click handler error', err); }
        };

        // Auto-close after 10s to avoid lingering notifications
        setTimeout(() => { try { notif.close && notif.close(); } catch (e) {} }, 10000);
    } catch (err) {
        console.debug('Error showing desktop notification', err);
    }
}

// Open image in modal
window.openImageModal = function(imageUrl) {
    const modal = document.createElement('div');
    modal.className = 'image-modal';
    modal.innerHTML = `
        <div class="image-modal-content">
            <span class="image-modal-close">&times;</span>
            <img src="${imageUrl}" alt="Full size image">
        </div>
    `;
    
    document.body.appendChild(modal);
    
    // Close modal handlers
    modal.addEventListener('click', (e) => {
        if (e.target === modal || e.target.className === 'image-modal-close') {
            document.body.removeChild(modal);
        }
    });
}

// Open profile picture in modal
window.openProfileModal = function(imageUrl, username) {
    const modal = document.createElement('div');
    modal.className = 'image-modal';
    modal.innerHTML = `
        <div class="image-modal-content">
            <span class="image-modal-close">&times;</span>
            <img src="${imageUrl}" alt="${username}'s profile picture">
            <div class="profile-modal-info">
                <h3>@${escapeHtml(username)}</h3>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
    
    // Close modal handlers
    modal.addEventListener('click', (e) => {
        if (e.target === modal || e.target.className === 'image-modal-close') {
            document.body.removeChild(modal);
        }
    });
}

// Escape HTML to prevent XSS
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Format last seen timestamp into a short relative string
function formatLastSeen(timestamp) {
    if (!timestamp) return 'Last seen: unknown';
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now - date;
    if (diff < 60000) return 'Last seen just now';
    if (diff < 3600000) return `Last seen ${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `Last seen ${Math.floor(diff / 3600000)}h ago`;
    if (diff < 604800000) return `Last seen ${Math.floor(diff / 86400000)}d ago`;
    return `Last seen on ${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
}

// Update the active chat header status (Online / Last seen ...)
function updateActiveChatStatus(online, lastSeen) {
    const statusEl = document.getElementById('activeChatStatus');
    if (!statusEl) return;
    const dotEl = document.getElementById('activeChatStatusDot');
    const textEl = document.getElementById('activeChatStatusText');
    if (!textEl) return;
    if (dotEl) {
        if (online) {
            dotEl.classList.add('online');
        } else {
            dotEl.classList.remove('online');
        }
    }
    if (online) {
        textEl.textContent = 'Online';
    } else {
        textEl.textContent = formatLastSeen(lastSeen);
    }
}

// Show/hide typing indicator DOM
function updateTypingIndicator(show) {
    const indicator = document.getElementById('typingIndicator');
    if (!indicator) return;
    if (show) {
        indicator.style.display = 'inline-block';
        // Update chat list preview for active chat
        if (activeChat && activeChat.id) {
            const chatListItem = document.querySelector(`.chat-list-item[data-friend-id="${activeChat.id}"]`);
            if (chatListItem) {
                const msgEl = chatListItem.querySelector('.chat-list-message');
                if (msgEl) {
                    msgEl.dataset.origPreview = msgEl.dataset.preview || msgEl.textContent;
                    msgEl.textContent = 'typing...';
                    msgEl.classList.add('typing');
                    const dotEl = chatListItem.querySelector('.chat-list-status');
                    if (dotEl) dotEl.classList.add('typing-dot');
                }
            }
        }
    } else {
        indicator.style.display = 'none';
        // Restore chat list preview for active chat
        if (activeChat && activeChat.id) {
            const chatListItem = document.querySelector(`.chat-list-item[data-friend-id="${activeChat.id}"]`);
            if (chatListItem) {
                const msgEl = chatListItem.querySelector('.chat-list-message');
                if (msgEl) {
                    const orig = msgEl.dataset.origPreview || msgEl.dataset.preview;
                    msgEl.textContent = orig || msgEl.textContent;
                    msgEl.classList.remove('typing');
                }
                const dotEl = chatListItem.querySelector('.chat-list-status');
                if (dotEl) dotEl.classList.remove('typing-dot');
            }
        }
    }
}

// Set/remove typing flag in the DB for current user
async function setTypingFlag(chatRoomId, typing) {
    if (!currentUser || !chatRoomId) return;
    const typingRef = ref(database, `chatRooms/${chatRoomId}/typing/${currentUser.uid}`);
    try {
        if (typing) {
            await set(typingRef, true);
            // Ensure it's removed on disconnect
            onDisconnect(typingRef).remove();
            isTypingLocal = true;
        } else {
            await remove(typingRef);
            isTypingLocal = false;
        }
    } catch (error) {
        console.error('Error setting typing flag:', error);
    }
}

// Update the sidebar/status indicator for a user in the lists
function updateSidebarStatus(friendId, online, lastSeen) {
    const chatListItem = document.querySelector(`.chat-list-item[data-friend-id="${friendId}"]`);
    if (chatListItem) {
        let statusEl = chatListItem.querySelector('.chat-list-status');
        if (!statusEl) {
            // add status element
            const nameEl = chatListItem.querySelector('.chat-list-name');
            if (nameEl) {
                statusEl = document.createElement('span');
                statusEl.className = 'chat-list-status';
                nameEl.appendChild(statusEl);
            }
        }
        if (statusEl) {
            if (online) {
                statusEl.classList.add('online');
                statusEl.title = 'Online';
            } else {
                statusEl.classList.remove('online');
                statusEl.title = formatLastSeen(lastSeen);
            }
        }
    }

    // Also clear any sending flag if online state changed and it's not sending
    const chatListItemSendingEl = document.querySelector(`.chat-list-item[data-friend-id="${friendId}"] .chat-list-status`);
    if (chatListItemSendingEl && !online) {
        chatListItemSendingEl.classList.remove('sending');
    }

    const sidebarItem = document.querySelector(`.sidebar-contact-item[data-friend-id="${friendId}"]`);
    if (sidebarItem) {
        const statusEl = sidebarItem.querySelector('.sidebar-contact-status');
        if (statusEl) {
            if (online) {
                statusEl.classList.add('online');
                statusEl.title = 'Online';
            } else {
                statusEl.classList.remove('online');
                statusEl.title = formatLastSeen(lastSeen);
            }
        }
    }
}

// Update the sidebar/chat list to show a small sending spinner for a given friend
function updateSidebarSending(friendId, sending) {
    const chatListItem = document.querySelector(`.chat-list-item[data-friend-id="${friendId}"]`);
    if (chatListItem) {
        const statusEl = chatListItem.querySelector('.chat-list-status');
        if (statusEl) {
            if (sending) {
                statusEl.classList.add('sending');
                statusEl.title = 'Sending...';
            } else {
                statusEl.classList.remove('sending');
                // If online flag exists, ensure online class returns
                const fr = friendsList[friendId];
                if (fr && fr.online) statusEl.classList.add('online');
            }
        }
    }
    // Sidebar contact item
    const sidebarItem = document.querySelector(`.sidebar-contact-item[data-friend-id="${friendId}"]`);
    if (sidebarItem) {
        const statusEl = sidebarItem.querySelector('.sidebar-contact-status');
        if (statusEl) {
            if (sending) {
                statusEl.classList.add('sending');
                statusEl.title = 'Sending...';
            } else {
                statusEl.classList.remove('sending');
            }
        }
    }
}

// Auto-focus on message input
document.addEventListener('DOMContentLoaded', () => {
    const messageInput = document.getElementById('messageInput');
    if (messageInput) {
        messageInput.focus();
        // Add typing handlers
        messageInput.addEventListener('input', () => {
            if (!currentUser || !activeChat) return;
            const chatRoomId = [currentUser.uid, activeChat.id].sort().join('_');
            if (!isTypingLocal) {
                setTypingFlag(chatRoomId, true);
            }
            if (typingTimeout) clearTimeout(typingTimeout);
            typingTimeout = setTimeout(() => {
                setTypingFlag(chatRoomId, false);
            }, 1500);
        });

        messageInput.addEventListener('blur', () => {
            if (!currentUser || !activeChat) return;
            const chatRoomId = [currentUser.uid, activeChat.id].sort().join('_');
            setTypingFlag(chatRoomId, false);
        });
    }
    // Initialize notification settings UI and apply saved setting
    try { setupNotificationSettingsUI(); } catch (e) { /* ignore */ }
    try { applyNotificationSoundSetting(); } catch (e) { /* ignore */ }
});

// Listen for messages from the service worker (e.g., notificationclick forwarding)
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (ev) => {
        try {
            const data = ev.data || {};
            if (data && data.action === 'openChat' && data.friendId) {
                const fid = data.friendId;
                const friend = friendsList[fid];
                if (friend) {
                    selectContact(fid, friend);
                } else {
                    // If we don't have the friend cached yet, attempt to fetch minimal data
                    // (This is best-effort; app will still focus and user can select contact manually)
                    console.debug('SW asked to open chat for unknown friendId', fid);
                }
            }
        } catch (err) { console.debug('serviceWorker message handler error', err); }
    });
}
