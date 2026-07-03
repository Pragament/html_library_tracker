import { db } from "../firebase/firebase.js";
import { 
    collection, 
    doc, 
    setDoc, 
    updateDoc, 
    deleteDoc, 
    getDoc, 
    query, 
    orderBy, 
    onSnapshot,
    serverTimestamp,
    writeBatch
} from "https://www.gstatic.com/firebasejs/9.8.1/firebase-firestore.js";

// Subscribe to all users in real-time
export function subscribeToUsers(callback) {
    const q = query(collection(db, "users"), orderBy("name"));
    return onSnapshot(q, (snapshot) => {
        const users = [];
        snapshot.forEach((doc) => {
            users.push({ id: doc.id, ...doc.data() });
        });
        callback(users);
    }, (error) => {
        console.error("Error subscribing to users:", error);
    });
}

// Register a new user
export async function registerUser(userId, userData) {
    const userRef = doc(db, "users", userId);
    const data = {
        id: userId,
        userId: userId,
        name: userData.name || "",
        email: userData.email || "",
        phone: userData.phone || "",
        membershipType: userData.membershipType || "Student",
        class: userData.membershipType || "Student", // keep compatibility for existing UI displays
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        joinedAt: serverTimestamp()
    };
    await setDoc(userRef, data);

    // Sync to staff or visitors collection if appropriate
    if (userData.membershipType === "Staff") {
        await setDoc(doc(db, "staff", userId), data);
    } else if (userData.membershipType === "Visitor") {
        await setDoc(doc(db, "visitors", userId), data);
    }
}

// Update user details
export async function updateUser(userId, userData) {
    const userRef = doc(db, "users", userId);
    const updatePayload = {
        ...userData,
        class: userData.membershipType || userData.class || "Student", // sync class
        updatedAt: serverTimestamp()
    };
    await updateDoc(userRef, updatePayload);

    // Remove from other collections first to prevent stale records if membershipType changed
    await deleteDoc(doc(db, "staff", userId)).catch(() => {});
    await deleteDoc(doc(db, "visitors", userId)).catch(() => {});

    // Sync to appropriate collection
    if (userData.membershipType === "Staff" || userData.class === "Staff") {
        const fullSnap = await getDoc(userRef);
        if (fullSnap.exists()) {
            await setDoc(doc(db, "staff", userId), fullSnap.data());
        }
    } else if (userData.membershipType === "Visitor" || userData.class === "Visitor") {
        const fullSnap = await getDoc(userRef);
        if (fullSnap.exists()) {
            await setDoc(doc(db, "visitors", userId), fullSnap.data());
        }
    }
}

// Delete user
export async function deleteUser(userId) {
    const userRef = doc(db, "users", userId);
    await deleteDoc(userRef);
    await deleteDoc(doc(db, "staff", userId)).catch(() => {});
    await deleteDoc(doc(db, "visitors", userId)).catch(() => {});
}

// Retrieve single user details
export async function getUser(userId) {
    const userRef = doc(db, "users", userId);
    const snap = await getDoc(userRef);
    if (snap.exists()) {
        return { id: snap.id, ...snap.data() };
    }
    return null;
}

// Bulk import users
export async function importUsersBulk(usersArray) {
    const chunks = [];
    let batch = writeBatch(db);
    let count = 0;

    for (const user of usersArray) {
        const docRef = doc(db, "users", user.id);
        batch.set(docRef, user);

        // Sync to staff or visitors collection if appropriate
        if (user.membershipType === "Staff") {
            batch.set(doc(db, "staff", user.id), user);
        } else if (user.membershipType === "Visitor") {
            batch.set(doc(db, "visitors", user.id), user);
        }

        count++;
        if (count % 500 === 0) {
            chunks.push(batch);
            batch = writeBatch(db);
        }
    }
    if (count % 500 !== 0) chunks.push(batch);

    for (const b of chunks) {
        await b.commit();
    }
}
