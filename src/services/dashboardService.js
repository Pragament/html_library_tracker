import { db } from "../firebase/firebase.js";
import { 
    collection, 
    query, 
    where,
    onSnapshot,
    doc,
    setDoc,
    getDoc,
    getDocs,
    deleteDoc,
    writeBatch
} from "https://www.gstatic.com/firebasejs/9.8.1/firebase-firestore.js";

// Setup dynamic realtime listener that returns updates for all 8 required dashboard metrics
export function subscribeToDashboardStats(callback) {
    const unsubscribes = [];
    const stats = {
        totalBooks: 0,
        availableBooks: 0,
        borrowedBooks: 0,
        totalUsers: 0,
        visitors: 0,
        returnedBooks: 0,
        activeRecords: 0,
        totalFineCollected: 0
    };

    const notify = () => callback({ ...stats });

    // 1. Books listener
    const unsubBooks = onSnapshot(collection(db, "books"), (snap) => {
        stats.totalBooks = snap.size;
        let available = 0;
        let borrowed = 0;
        snap.forEach(docSnap => {
            const data = docSnap.data();
            available += (data.availableCopies || 0);
            borrowed += (data.issuedCopies || 0);
        });
        stats.availableBooks = available;
        stats.borrowedBooks = borrowed;
        notify();
    }, err => console.error("Dashboard books stats error:", err));
    unsubscribes.push(unsubBooks);

    // 2. Users listener
    const unsubUsers = onSnapshot(collection(db, "users"), (snap) => {
        stats.totalUsers = snap.size;
        notify();
    }, err => console.error("Dashboard users stats error:", err));
    unsubscribes.push(unsubUsers);

    // 3. Borrow records listener
    const unsubRecords = onSnapshot(collection(db, "borrowRecords"), (snap) => {
        let active = 0;
        let returned = 0;
        snap.forEach(docSnap => {
            const data = docSnap.data();
            if (data.status === "Borrowed") active++;
            if (data.status === "Returned") returned++;
        });
        stats.activeRecords = active;
        stats.returnedBooks = returned;
        notify();
    }, err => console.error("Dashboard records stats error:", err));
    unsubscribes.push(unsubRecords);

    // 4. Visitors listener
    const unsubVisitors = onSnapshot(collection(db, "visitors"), (snap) => {
        stats.visitors = snap.size;
        notify();
    }, err => console.error("Dashboard visitors stats error:", err));
    unsubscribes.push(unsubVisitors);

    // 5. Fines listener
    const unsubFines = onSnapshot(collection(db, "fines"), (snap) => {
        let fineSum = 0;
        snap.forEach(docSnap => {
            fineSum += (docSnap.data().amount || 0);
        });
        stats.totalFineCollected = fineSum;
        notify();
    }, err => console.error("Dashboard fines stats error:", err));
    unsubscribes.push(unsubFines);

    return () => unsubscribes.forEach(unsub => unsub());
}

// Subscribe to archive reasons
export function subscribeToArchiveReasons(callback) {
    return onSnapshot(doc(db, "settings", "archiveReasons"), (docSnap) => {
        if (docSnap.exists()) {
            callback(docSnap.data().reasons || []);
        } else {
            const defaultReasons = ['Accidental entry', 'Typo', 'Duplicate', 'Wrong student', 'Wrong book', 'System error'];
            setDoc(doc(db, "settings", "archiveReasons"), { reasons: defaultReasons })
                .then(() => callback(defaultReasons))
                .catch(err => console.error(err));
        }
    }, err => console.error("Reasons sync error:", err));
}

// Add an archive reason
export async function addArchiveReason(newReasons) {
    await setDoc(doc(db, "settings", "archiveReasons"), { reasons: newReasons });
}

// Subscribe to Supabase connection configuration
export function subscribeToSupabaseConfig(callback) {
    return onSnapshot(doc(db, "settings", "supabase"), (docSnap) => {
        if (docSnap.exists()) {
            callback(docSnap.data());
        }
    }, err => console.error("Supabase config sync error:", err));
}

// Save Supabase connection configuration
export async function saveSupabaseConfig(url, key) {
    await setDoc(doc(db, "settings", "supabase"), { url, key });
}

// Clear all database collections in Firestore
export async function clearAllCollections() {
    const collections = ['books', 'users', 'borrowRecords', 'fines', 'visitors', 'staff'];
    for (const colName of collections) {
        const snap = await getDocs(collection(db, colName));
        const chunks = [];
        let batch = writeBatch(db);
        let count = 0;
        snap.forEach(docSnap => {
            batch.delete(docSnap.ref);
            count++;
            if (count % 500 === 0) {
                chunks.push(batch);
                batch = writeBatch(db);
            }
        });
        if (count % 500 !== 0) chunks.push(batch);

        for (const b of chunks) {
            await b.commit();
        }
    }
}
