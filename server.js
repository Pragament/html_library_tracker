
require('dotenv').config();

// Check required environment variables
if (
    !process.env.SUPABASE_URL ||
    !process.env.SUPABASE_SECRET_KEY ||
    !process.env.JWT_SECRET
) {
    console.error('Missing required environment variables. Check .env.');
    process.exit(1);
}

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');
const jwt = require('jsonwebtoken');
const { initializeApp, cert } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
// Initialize Firebase Admin SDK
const serviceAccount = require(
    process.env.FIREBASE_SERVICE_ACCOUNT_PATH ||
    './firebase-service-account.json'
);

initializeApp({
    credential: cert(serviceAccount)
});
const app = express();
const PORT = process.env.PORT || 3000;
// Verify Firebase librarian authentication
async function verifyLibrarianToken(req, res, next) {
    try {
        const authHeader = req.headers.authorization;

        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({
                success: false,
                error: 'Authentication required.'
            });
        }

        const token = authHeader.split(' ')[1];
        const decoded = await getAuth().verifyIdToken(token);
        const allowedEmails = (process.env.LIBRARIAN_EMAILS || '')
            .split(',')
            .map(email => email.trim().toLowerCase())
            .filter(Boolean);

        if (
            !decoded.email ||
            decoded.email_verified !== true ||
            !allowedEmails.includes(decoded.email.toLowerCase())
        ) {
            return res.status(403).json({
                success: false,
                error: 'Librarian access denied.'
            });
        }

        req.librarian = {
            uid: decoded.uid,
            email: decoded.email
        };

        next();

    } catch (error) {
        return res.status(401).json({
            success: false,
            error: 'Invalid or expired login.'
        });
    }
}

// Middleware
app.use(helmet());

app.use(cors({
    origin: process.env.FRONTEND_URL || 'http://127.0.0.1:5500'
}));

app.use(express.json({ limit: '10kb' }));

// Limit repeated login attempts
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    message: {
        error: 'Too many attempts. Please try again later.'
    }
});

// Supabase server connection
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SECRET_KEY
);

// Home / API health check
app.get('/', (req, res) => {
    res.json({
        message: 'LibraryManager API is running'
    });
});

// Supabase database health check
app.get('/api/health/database', async (req, res) => {
    try {
        const { error } = await supabase
            .from('books')
            .select('id')
            .limit(1);

        if (error) throw error;

        res.json({
            success: true,
            message: 'Supabase database connected successfully'
        });
    } catch (error) {
        console.error('Database check failed:', error.message);

        res.status(500).json({
            success: false,
            message: 'Supabase database connection failed'
        });
    }
});

 // Get books from Supabase (Student only)
app.get('/api/books', verifyStudentToken, async (req, res) => {
    try {
        const { data: books, error } = await supabase
            .from('books')
            .select('id, title, author, isbn, category, status')
            .order('title', { ascending: true });

        if (error) throw error;

        res.json({ success: true, books: books || [] });
    } catch (error) {
        console.error('Books API error:', error.message);
        res.status(500).json({
            success: false,
            error: 'Unable to retrieve books.'
        });
    }
});

// Get all books for librarian catalog
app.get('/api/admin/books', verifyLibrarianToken, async (req, res) => {
    try {
        const { data: books, error } = await supabase
            .from('books')
            .select('id, title, author, isbn, category, tags, status, addedAt, revisionHistory')
            .order('title', { ascending: true });

        if (error) throw error;

        res.json({
            success: true,
            books: books || []
        });

    } catch (error) {
        console.error('Admin books API error:', error.message);

        res.status(500).json({
            success: false,
            error: 'Unable to retrieve library catalog.'
        });
    }
});
// Create book reservation (Student only)
app.post('/api/reservations', verifyStudentToken, async (req, res) => {
    try {
        const { bookId } = req.body;

        if (!bookId) {
            return res.status(400).json({
                success: false,
                error: 'Book ID is required.'
            });
        }

        // Check whether the book exists and is available
        const { data: book, error: bookError } = await supabase
            .from('books')
            .select('id, status')
            .eq('id', bookId)
            .maybeSingle();

        if (bookError) throw bookError;

        if (!book || book.status !== 'available') {
            return res.status(400).json({
                success: false,
                error: 'This book is not available.'
            });
        }

        // Prevent duplicate pending reservations
        const { data: existing, error: existingError } = await supabase
            .from('reservations')
            .select('id')
            .eq('book_id', bookId)
            .eq('student_id', req.studentId)
            .eq('status', 'pending')
            .maybeSingle();

        if (existingError) throw existingError;

        if (existing) {
            return res.status(409).json({
                success: false,
                error: 'You have already reserved this book.'
            });
        }

        const newReservation = {
            id: 'res_' + Date.now(),
            book_id: bookId,
            student_id: req.studentId,
            status: 'pending'
        };

        const { data, error } = await supabase
            .from('reservations')
            .insert(newReservation)
            .select('id, book_id, student_id, status, created_at')
            .single();

        if (error) throw error;

        res.status(201).json({
            success: true,
            reservation: data
        });

    } catch (error) {
        console.error('Reservation API error:', error.message);

        res.status(500).json({
            success: false,
            error: 'Unable to create reservation.'
        });
    }
});
// Approve a student reservation (Librarian only)
app.post('/api/admin/reservations/:id/approve', verifyLibrarianToken, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('reservations')
            .update({ status: 'approved' })
            .eq('id', req.params.id)
            .eq('status', 'pending')
            .select('id, book_id, student_id, status, created_at')
            .maybeSingle();

        if (error) throw error;

        if (!data) {
            return res.status(409).json({
                success: false,
                error: 'Reservation not found or already processed.'
            });
        }

        res.json({
            success: true,
            reservation: data
        });

    } catch (error) {
        console.error('Approve reservation error:', error.message);

        res.status(500).json({
            success: false,
            error: 'Unable to approve reservation.'
        });
    }
});
// Issue an approved reservation (Librarian only)
app.post('/api/admin/reservations/:id/issue', verifyLibrarianToken, async (req, res) => {
    try {
        const { data, error } = await supabase.rpc(
            'issue_reserved_book',
            {
                p_reservation_id: req.params.id,
                p_created_by: req.librarian.email
            }
        );

        if (error) throw error;

        res.json({
            success: true,
            result: data
        });

    } catch (error) {
        console.error('Issue book API error:', error.message);

        res.status(400).json({
            success: false,
            error: error.message || 'Unable to issue book.'
        });
    }
});

// Get active borrowed books (Librarian only)
app.get('/api/admin/transactions/active', verifyLibrarianToken, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('library_transactions')
            .select(`
                id,
                book_id,
                student_id,
                due_date,
                created_at,
                books(title),
                students(name, admission_number)
            `)
            .eq('type', 'borrow')
            .is('returned_at', null)
            .order('created_at', { ascending: false });

        if (error) throw error;

        res.json({
            success: true,
            transactions: data || []
        });

    } catch (error) {
        console.error('Active transactions API error:', error.message);
        res.status(500).json({
            success: false,
            error: 'Unable to load active borrowed books.'
        });
    }
});
// Return a borrowed book (Librarian only)
app.post('/api/admin/transactions/:id/return', verifyLibrarianToken, async (req, res) => {
    try {
        const transactionId = req.params.id;

        // Find the active borrowing record
        const { data: transaction, error: findError } = await supabase
            .from('library_transactions')
            .select('id, book_id, returned_at, type, student_id')
            .eq('id', transactionId)
            .single();

        if (findError) throw findError;

        if (transaction.type !== 'borrow' || transaction.returned_at) {
            return res.status(400).json({
                success: false,
                error: 'This book is already returned or is not a borrowing record.'
            });
        }

        // Mark the borrowing record as returned
        const { error: updateError } = await supabase
            .from('library_transactions')
            .update({
                returned_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            })
            .eq('id', transactionId)
            .is('returned_at', null);

        if (updateError) throw updateError;

        // Make the book available again
        const { error: bookError } = await supabase
            .from('books')
            .update({ status: 'available' })
            .eq('id', transaction.book_id)
            .eq('status', 'borrowed');

        if (bookError) throw bookError;
        // Update reservation status
const { error: reservationError } = await supabase
    .from('reservations')
    .update({ status: 'returned' })
    .eq('book_id', transaction.book_id)
    .eq('student_id', transaction.student_id)
    .eq('status', 'issued');
if (reservationError) throw reservationError;

        res.json({
            success: true,
            message: 'Book returned successfully.'
        });

    } catch (error) {
        console.error('Return book API error:', error.message);
        res.status(400).json({
            success: false,
            error: error.message || 'Unable to return book.'
        });
    }
});
// Get all reservations (Librarian only)
app.get('/api/admin/reservations', verifyLibrarianToken, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('reservations')
            .select(`
                id,
                book_id,
                student_id,
                status,
                created_at,
                books(title),
                students(name, admission_number)
            `)
            .order('created_at', { ascending: false });

        if (error) throw error;

        res.json({
            success: true,
            reservations: data || []
        });

    } catch (error) {
        console.error('Reservations API error:', error.message);

        res.status(500).json({
            success: false,
            error: 'Unable to retrieve reservations.'
        });
    }
});
// Add a book (Librarian only)
app.post('/api/books', verifyLibrarianToken, async (req, res) => {
    try {
        const { title, author, isbn, tags, status } = req.body;

        if (!title || typeof title !== 'string' || !title.trim()) {
            return res.status(400).json({
                success: false,
                error: 'Book title is required.'
            });
        }

        const newBook = {
            id: 'bk_' + Date.now(),
            title: title.trim(),
            author: author || '',
            isbn: isbn || '',
            category: 'General',
            tags: Array.isArray(tags) ? tags : [],
            status: ['available', 'borrowed', 'archived'].includes(status)
                ? status : 'available',
            addedAt: new Date().toISOString(),
            revisionHistory: []
        };

        const { data, error } = await supabase
            .from('books')
            .insert(newBook)
            .select('id, title, author, isbn, category, status')
            .single();

        if (error) throw error;

        res.status(201).json({ success: true, book: data });
    } catch (error) {
        console.error('Add book API error:', error.message);
        res.status(500).json({
            success: false,
            error: 'Unable to save book.'
        });
    }
});

// Update an existing book (Librarian only)
app.put('/api/books/:id', verifyLibrarianToken, async (req, res) => {
    try {
        const { title, author, isbn, tags, status } = req.body;

        const { data: book, error } = await supabase
            .from('books')
            .update({
                title,
                author,
                isbn,
                tags: tags || [],
                status
            })
            .eq('id', req.params.id)
            .select()
            .single();

        if (error) throw error;

        res.json({
            success: true,
            book
        });

    } catch (error) {
        console.error('Update book API error:', error.message);
        res.status(400).json({
            success: false,
            error: error.message || 'Unable to update book.'
        });
    }
});

// Student login
app.post('/api/student/login', loginLimiter, async (req, res) => {
    try {
        const admission = String(req.body.admission || '').trim();
        const phone = String(req.body.phone || '').replace(/\D/g, '');

        if (!admission || phone.length < 10) {
            return res.status(400).json({
                error: 'Enter valid admission number and phone number.'
            });
        }

        const { data: student, error } = await supabase
            .from('students')
            .select('id, admission_number, name, phone_number')
            .eq('admission_number', admission)
            .maybeSingle();

        if (error) throw error;

        const storedPhone = String(student?.phone_number || '')
            .replace(/\D/g, '');

        if (
            !student ||
            storedPhone.length < 10 ||
            storedPhone.slice(-10) !== phone.slice(-10)
        ) {
            return res.status(401).json({
                error: 'Invalid admission number or phone number.'
            });
        }

        // Create signed student session token
        const token = jwt.sign(
            {
                sub: student.id,
                role: 'student'
            },
            process.env.JWT_SECRET,
            {
                expiresIn: '2h'
            }
        );

        res.json({
            success: true,
            token,
            student: {
                id: student.id,
                name: student.name,
                admissionNumber: student.admission_number
            }
        });

    } catch (error) {
        console.error('Student login error:', error.message);

        res.status(500).json({
            error: 'Unable to verify student.'
        });
    }
});

// Verify student login token
function verifyStudentToken(req, res, next) {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({
            error: 'Login required.'
        });
    }

    try {
        const token = authHeader.split(' ')[1];

        const decoded = jwt.verify(
            token,
            process.env.JWT_SECRET
        );

        if (decoded.role !== 'student' || !decoded.sub) {
            return res.status(403).json({
                error: 'Access denied.'
            });
        }

        req.studentId = decoded.sub;
        next();

    } catch {
        return res.status(401).json({
            error: 'Session expired. Please log in again.'
        });
    }
}

// Verify current student session
app.get('/api/student/me', verifyStudentToken, async (req, res) => {
    try {
        const { data: student, error } = await supabase
            .from('students')
            .select('id, admission_number, name')
            .eq('id', req.studentId)
            .maybeSingle();

        if (error) throw error;

        if (!student) {
            return res.status(404).json({
                error: 'Student not found.'
            });
        }

        res.json({
            success: true,
            student: {
                id: student.id,
                name: student.name,
                admissionNumber: student.admission_number
            }
        });

    } catch (error) {
        console.error('Session verification error:', error.message);

        res.status(500).json({
            error: 'Unable to verify session.'
        });
    }
});

// Get student's borrowing history
app.get('/api/student/transactions', verifyStudentToken, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('library_transactions')
            .select(`
                id,
                book_id,
                type,
                due_date,
                returned_at,
                created_at,
                books(title)
            `)
            .eq('student_id', req.studentId)
            .eq('type', 'borrow')
            .order('created_at', { ascending: false });

        if (error) throw error;

        res.json({
            success: true,
            transactions: data || []
        });

    } catch (error) {
        console.error('Student transactions API error:', error.message);

        res.status(500).json({
            success: false,
            error: 'Unable to load borrowing history.'
        });
    }
});

// Get student's reservations
app.get('/api/student/reservations', verifyStudentToken, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('reservations')
            .select(`
                id,
                book_id,
                status,
                created_at,
                books(title)
            `)
            .eq('student_id', req.studentId)
            .order('created_at', { ascending: false });

        if (error) throw error;

        res.json({
            success: true,
            reservations: data || []
        });

    } catch (error) {
        console.error('Student reservations API error:', error.message);

        res.status(500).json({
            success: false,
            error: 'Unable to load reservations.'
        });
    }
});
// Start server AFTER registering all routes
app.listen(PORT, () => {
    console.log(`LibraryManager API running on port ${PORT}`);
});
