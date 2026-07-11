// Import Firebase SDK
import { initializeApp } from "https://www.gstatic.com/firebasejs/9.8.1/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/9.8.1/firebase-firestore.js";
import { getAuth, GoogleAuthProvider } from "https://www.gstatic.com/firebasejs/9.8.1/firebase-auth.js";

// Your Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyBEie9kXTsMxzFdOA1Oel4GYH-n-8RyjHw",
  authDomain: "html-library-traker.firebaseapp.com",
  projectId: "html-library-traker",
  storageBucket: "html-library-traker.firebasestorage.app",
  messagingSenderId: "1037520475416",
  appId: "1:1037520475416:web:54966a3d23285f2b163a6d",
  measurementId: "G-2TDBL6DN8X"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);

// Initialize Firestore
const db = getFirestore(app);

// Initialize Authentication
const auth = getAuth(app);

// Google Authentication Provider
const provider = new GoogleAuthProvider();

// Export everything
export { app, db, auth, provider };