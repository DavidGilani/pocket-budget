import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getAuth, GoogleAuthProvider,
  signInWithPopup, signInWithRedirect, getRedirectResult,
  signOut, onAuthStateChanged,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {
  initializeFirestore, persistentLocalCache,
  collection, doc, getDoc, setDoc, getDocs,
  writeBatch, query, where, serverTimestamp, Timestamp,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

const firebaseConfig = {
  apiKey: "AIzaSyBMlheppbe77DZkfrIqoWHqR4rgVByRU0Y",
  authDomain: "pocket-budget-d42a7.firebaseapp.com",
  projectId: "pocket-budget-d42a7",
  storageBucket: "pocket-budget-d42a7.firebasestorage.app",
  messagingSenderId: "561470944083",
  appId: "1:561470944083:web:9d5f680aa94006c8e767a6",
};

const fbApp = initializeApp(firebaseConfig);
export const auth = getAuth(fbApp);

// Persistent cache enables offline reads/writes
export const firestore = initializeFirestore(fbApp, {
  localCache: persistentLocalCache(),
});

const googleProvider = new GoogleAuthProvider();

export async function signInWithGoogle() {
  try {
    return await signInWithPopup(auth, googleProvider);
  } catch (e) {
    // Fall back to redirect for browsers that block popups (e.g. iOS PWA)
    if (e.code === 'auth/popup-blocked' || e.code === 'auth/cancelled-popup-request') {
      return signInWithRedirect(auth, googleProvider);
    }
    throw e;
  }
}

export const handleRedirectResult = () => getRedirectResult(auth).catch(() => null);
export const signOutUser = () => signOut(auth);
export const onAuthChange = cb => onAuthStateChanged(auth, cb);

export { collection, doc, getDoc, setDoc, getDocs, writeBatch, query, where, serverTimestamp, Timestamp };
