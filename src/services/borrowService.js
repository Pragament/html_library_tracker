import { db } from "../firebase/firebase.js";
import { 
    collection, 
    doc, 
    setDoc, 
    getDoc, 
    getDocs, 
    updateDoc, 
    deleteDoc,
    query, 
    where, 
    orderBy,
    onSnapshot,
    runTransaction,
    serverTimestamp,
    writeBatch
} from "https://www.gstatic.com/firebasejs/9.8.1/firebase-firestore.js";

// Subscribe to borrow records in real-time
export function subscribeToBorrowRecords(callback) {
    const q = query(collection(db, "borrowRecords"), orderBy("borrowDate", "desc"));
    return onSnapshot(q, (snapshot) => {
        const records = [];
        snapshot.forEach((docSnap) => {
            const data = docSnap.data();
            records.push({
                id: data.borrowRecordId || docSnap.id,
                bookId: data.bookId,
                studentId: data.userId,
                type: data.status === "Borrowed" ? "borrow" : "return",
                createdAt: data.borrowDate ? (data.borrowDate.toDate ? data.borrowDate.toDate().toISOString() : new Date(data.borrowDate).toISOString()) : new Date().toISOString(),
                borrowDate: data.borrowDate ? (data.borrowDate.toDate ? data.borrowDate.toDate().toISOString() : new Date(data.borrowDate).toISOString()) : null,
                dueDate: data.dueDate ? (data.dueDate.toDate ? data.dueDate.toDate().toISOString() : new Date(data.dueDate).toISOString()) : null,
                returnDate: data.returnDate ? (data.returnDate.toDate ? data.returnDate.toDate().toISOString() : new Date(data.returnDate).toISOString()) : null,
                createdBy: "system",
                archived: data.status === "Returned"
            });
        });
        callback(records);
    }, (error) => {
        console.error("Error subscribing to borrow records:", error);
    });
}

// Check out a book
export async function borrowBook(userId, bookId, userName, bookTitle) {
    await runTransaction(db, async (transaction) => {
        const bookRef = doc(db, "books", bookId);
        const bookDoc = await transaction.get(bookRef);

        if (!bookDoc.exists()) {
            throw new Error("Book not found in Firestore.");
        }

        // Fetch User and verify they are not a Visitor
        const userRef = doc(db, "users", userId);
        const userDoc = await transaction.get(userRef);
        if (userDoc.exists()) {
            const userData = userDoc.data();
            if (userData.membershipType === "Visitor" || userData.class === "Visitor") {
                throw new Error("Visitors are not allowed to borrow books.");
            }
        }

        const bookData = bookDoc.data();
        const totalCopies = Number(bookData.totalCopies) || 0;
        const issuedCopies = Number(bookData.issuedCopies) || 0;
        const availableVal = bookData.available === true || bookData.available === "true";

        // Console logs for debugging (Requirement 10)
        console.log("Firestore document ID:", bookId);
        console.log("Complete book object:", bookData);
        console.log("available value:", bookData.available, "type:", typeof bookData.available);
        console.log("issuedCopies:", issuedCopies, "type:", typeof issuedCopies);
        console.log("totalCopies:", totalCopies, "type:", typeof totalCopies);

        // Verification of book availability (Requirement 7)
        if (!availableVal || issuedCopies >= totalCopies) {
            throw new Error("Book is currently unavailable.");
        }

        // Prevent duplicate borrowing of the same book by the same user
        const activeTxQuery = query(
            collection(db, "borrowRecords"),
            where("userId", "==", userId),
            where("bookId", "==", bookId),
            where("status", "==", "Borrowed")
        );
        const activeSnap = await getDocs(activeTxQuery);
        if (!activeSnap.empty) {
            throw new Error("This user has already checked out an active copy of this book.");
        }

        // Create borrow record document
        const borrowRef = doc(collection(db, "borrowRecords"));
        const borrowDate = new Date();
        const dueDate = new Date();
        dueDate.setDate(borrowDate.getDate() + 14); // 14 Days return window

        transaction.set(borrowRef, {
            borrowRecordId: borrowRef.id,
            userId,
            userName,
            bookId,
            bookTitle,
            borrowDate: borrowDate,
            dueDate: dueDate,
            returnDate: null,
            status: "Borrowed",
            fineAmount: 0
        });

        // Update book availability details (Requirement 8)
        const newIssued = issuedCopies + 1;
        const newAvailableBool = newIssued < totalCopies;

        transaction.update(bookRef, {
            issuedCopies: newIssued,
            availableCopies: Math.max(0, totalCopies - newIssued),
            available: newAvailableBool,
            status: newAvailableBool ? 'available' : 'borrowed',
            borrowedBy: userId,
            updatedAt: serverTimestamp()
        });
    });
}

// Return a book and calculate fines
export async function returnBook(searchTerm) {
    // Search active borrow records by either bookId or borrowRecordId
    let recordDoc = null;
    
    // 1. Search by borrowRecordId
    const q1 = query(collection(db, "borrowRecords"), where("borrowRecordId", "==", searchTerm), where("status", "==", "Borrowed"));
    const snap1 = await getDocs(q1);
    if (!snap1.empty) {
        recordDoc = snap1.docs[0];
    } else {
        // 2. Search by bookId
        const q2 = query(collection(db, "borrowRecords"), where("bookId", "==", searchTerm), where("status", "==", "Borrowed"));
        const snap2 = await getDocs(q2);
        if (!snap2.empty) {
            recordDoc = snap2.docs[0];
        }
    }

    if (!recordDoc) {
        throw new Error("No active borrow record found for the given Book ID or Record ID.");
    }

    const recordData = recordDoc.data();
    const bookId = recordData.bookId;

    await runTransaction(db, async (transaction) => {
        const bookRef = doc(db, "books", bookId);
        const recordRef = doc(db, "borrowRecords", recordDoc.id);
        const bookDoc = await transaction.get(bookRef);

        if (!bookDoc.exists()) {
            throw new Error("Book does not exist in Firestore.");
        }

        const bookData = bookDoc.data();
        const issuedCopies = bookData.issuedCopies || 0;
        const availableCopies = bookData.availableCopies || 0;

        // Fetch user to verify membershipType
        const userRef = doc(db, "users", recordData.userId);
        const userDoc = await transaction.get(userRef);
        let isVisitor = false;
        if (userDoc.exists()) {
            const userData = userDoc.data();
            if (userData.membershipType === "Visitor" || userData.class === "Visitor") {
                isVisitor = true;
            }
        }

        // Calculate Overdue Fine ($1.00 per day overdue) - skip if Visitor
        const dueDate = recordData.dueDate.toDate ? recordData.dueDate.toDate() : new Date(recordData.dueDate);
        const returnDate = new Date();
        let fineAmount = 0;
        
        if (!isVisitor && returnDate > dueDate) {
            const overdueMs = returnDate - dueDate;
            const overdueDays = Math.ceil(overdueMs / (1000 * 60 * 60 * 24));
            fineAmount = overdueDays * 1.00; // $1.00 / day
        }

        // Update borrow record to Returned
        transaction.update(recordRef, {
            status: "Returned",
            returnDate: returnDate,
            fineAmount: fineAmount
        });

        // Update book availability
        const newIssued = Math.max(0, issuedCopies - 1);
        const newAvailable = availableCopies + 1;

        transaction.update(bookRef, {
            issuedCopies: newIssued,
            availableCopies: newAvailable,
            available: true,
            status: 'available',
            borrowedBy: null,
            updatedAt: serverTimestamp()
        });

        // If fine is generated, create a record in fines collection
        if (fineAmount > 0) {
            const fineRef = doc(collection(db, "fines"));
            transaction.set(fineRef, {
                fineId: fineRef.id,
                userId: recordData.userId,
                borrowRecordId: recordDoc.id,
                amount: fineAmount,
                status: "Unpaid",
                createdAt: serverTimestamp()
            });
        }
    });
}

// Archive/delete transaction record
export async function archiveTransactionRecord(id) {
    const docRef = doc(db, "borrowRecords", id);
    const docSnap = await getDoc(docRef);
    if (docSnap.exists) {
        const data = docSnap.data();
        if (data.status === "Borrowed") {
            const bookRef = doc(db, "books", data.bookId);
            const bookSnap = await getDoc(bookRef);
            if (bookSnap.exists) {
                const bookData = bookSnap.data();
                await updateDoc(bookRef, {
                    availableCopies: (bookData.availableCopies || 0) + 1,
                    issuedCopies: Math.max(0, (bookData.issuedCopies || 1) - 1),
                    available: true,
                    status: 'available',
                    borrowedBy: null,
                    updatedAt: serverTimestamp()
                });
            }
        }
    }
    await deleteDoc(docRef);
}

// Bulk import transactions (borrow records)
export async function importTransactionsBulk(transactionsArray) {
    const chunks = [];
    let batch = writeBatch(db);
    let count = 0;

    for (const tx of transactionsArray) {
        const docRef = doc(db, "borrowRecords", tx.id);
        const data = {
            borrowRecordId: tx.id,
            userId: tx.studentId || tx.userId || "",
            userName: tx.userName || "Student",
            bookId: tx.bookId || "",
            bookTitle: tx.bookTitle || "Book",
            borrowDate: tx.createdAt ? new Date(tx.createdAt) : new Date(),
            dueDate: tx.dueDate ? new Date(tx.dueDate) : new Date(),
            returnDate: tx.returnDate ? new Date(tx.returnDate) : null,
            status: tx.type === "borrow" ? "Borrowed" : "Returned",
            fineAmount: tx.fineAmount || 0
        };
        batch.set(docRef, data);
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

// Get member borrow stats & unpaid fines (Requirements 4, 5, 7)
export async function getMemberBorrowDetails(userId) {
    // 1. Get unpaid fines count and amount
    const finesQuery = query(collection(db, "fines"), where("userId", "==", userId), where("status", "==", "Unpaid"));
    const finesSnap = await getDocs(finesQuery);
    let pendingFine = 0;
    finesSnap.forEach(docSnap => {
        pendingFine += (docSnap.data().amount || 0);
    });

    // 2. Get active borrowed books count
    const borrowQuery = query(collection(db, "borrowRecords"), where("userId", "==", userId), where("status", "==", "Borrowed"));
    const borrowSnap = await getDocs(borrowQuery);
    const activeBorrows = borrowSnap.size;

    // 3. Check if user has any blocked overdue books
    let hasBlockedOverdue = false;
    const now = new Date();
    borrowSnap.forEach(docSnap => {
        const data = docSnap.data();
        const dueDate = data.dueDate ? (data.dueDate.toDate ? data.dueDate.toDate() : new Date(data.dueDate)) : null;
        if (dueDate && now > dueDate) {
            hasBlockedOverdue = true;
        }
    });

    return {
        pendingFine,
        activeBorrows,
        hasBlockedOverdue
    };
}
