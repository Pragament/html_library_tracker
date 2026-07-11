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

// Subscribe to all books in real-time
export function subscribeToBooks(callback) {
    const q = query(collection(db, "books"), orderBy("title"));
    return onSnapshot(q, (snapshot) => {
        const books = [];
        snapshot.forEach((doc) => {
            books.push({ id: doc.id, ...doc.data() });
        });
        callback(books);
    }, (error) => {
        console.error("Error subscribing to books:", error);
    });
}

// Add a new book doc
export async function addBook(bookData) {
    const newBookRef = doc(collection(db, "books"));
    const total = Number(bookData.totalCopies) || 1;

    const data = {
        id: newBookRef.id,
        bookId: newBookRef.id,
        title: bookData.title || "",
        author: bookData.author || "",
        isbn: bookData.isbn || "",
        publisher: bookData.publisher || "",
        publishedYear: bookData.publishedYear ? Number(bookData.publishedYear) : null,
        tags: bookData.tags || [],
        status: "Available",
        borrowedBy: null,
        category: bookData.category || "General",
        available: true,
        availableCopies: total,
        totalCopies: total,
        issuedCopies: 0,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        revisions: [{ action: "create", reason: "Book added", user: "system", timestamp: new Date().toISOString() }]
    };
    await setDoc(newBookRef, data);
    return newBookRef.id;
}

// Update book details
export async function updateBook(bookId, bookData) {
    const bookRef = doc(db, "books", bookId);
    const updatePayload = {
        ...bookData,
        updatedAt: serverTimestamp()
    };
    await updateDoc(bookRef, updatePayload);
}

// Delete book doc
export async function deleteBook(bookId) {
    const bookRef = doc(db, "books", bookId);
    await deleteDoc(bookRef);
}

// Retrieve single book
export async function getBook(bookId) {
    const bookRef = doc(db, "books", bookId);
    const snap = await getDoc(bookRef);
    if (snap.exists()) {
        return { id: snap.id, ...snap.data() };
    }
    return null;
}

// Bulk import books
export async function importBooksBulk(booksArray) {
    const chunks = [];
    let batch = writeBatch(db);
    let count = 0;

    for (const book of booksArray) {
        const docRef = doc(db, "books", book.id);
        batch.set(docRef, book);
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
