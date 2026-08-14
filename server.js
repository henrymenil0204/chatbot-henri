require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const Groq = require('groq-sdk');
const admin = require('firebase-admin');

const app = express();
const PORT = process.env.PORT || 3000;

// ---------- Middleware ----------
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Groq client ----------
if (!process.env.GROQ_API_KEY) {
  console.warn('WARNING: GROQ_API_KEY is not set. Chat requests will fail until you set it.');
}
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Model can be overridden via env var. Good default: fast + capable.
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

// ---------- Firebase Admin (Firestore + Auth) ----------
let db = null;
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    // Paste the full service account JSON into this env var (as a single line) when deploying.
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    db = admin.firestore();
    console.log('Firebase Admin initialized — chat history will be persisted to Firestore and auth will be enforced.');
  } else {
    console.warn('WARNING: FIREBASE_SERVICE_ACCOUNT is not set. Chat history will NOT be saved and auth cannot be verified.');
  }
} catch (err) {
  console.error('Failed to initialize Firebase Admin:', err.message);
}

// ---------- Auth middleware ----------
// Every route below (except /health) requires a valid Firebase ID token in
// the Authorization header. The client (public/chatbot.html) attaches this
// automatically via its authFetch() helper once someone is signed in.
async function verifyAuth(req, res, next) {
  if (!admin.apps.length) {
    return res.status(503).json({ error: 'Server auth is not configured (FIREBASE_SERVICE_ACCOUNT missing).' });
  }

  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;

  if (!token) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header. Please sign in.' });
  }

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.uid = decoded.uid;
    next();
  } catch (err) {
    console.error('Token verification failed:', err.message);
    res.status(401).json({ error: 'Invalid or expired session. Please sign in again.' });
  }
}

// ---------- Helpers ----------
// Chats are scoped per-user: users/{uid}/chats/{sessionId}/messages/*
// so one signed-in user can never read or delete another user's chats,
// even if they guess a sessionId.

// Saves a message AND keeps the parent session doc's metadata (title, last
// message, updatedAt) up to date so the sidebar can list sessions cheaply
// without scanning every message subcollection.
async function saveMessage(uid, sessionId, role, content) {
  if (!db) return;
  try {
    const chatRef = db.collection('users').doc(uid).collection('chats').doc(sessionId);

    await chatRef.collection('messages').add({
      role,
      content,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });

    const snap = await chatRef.get();
    const metaUpdate = {
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      lastMessage: content,
      lastRole: role,
    };

    // Set the session title from the first user message only.
    if (!snap.exists && role === 'user') {
      metaUpdate.title = content.length > 60 ? content.slice(0, 60) + '…' : content;
      metaUpdate.createdAt = admin.firestore.FieldValue.serverTimestamp();
    }

    await chatRef.set(metaUpdate, { merge: true });
  } catch (err) {
    console.error('Error saving message to Firestore:', err.message);
  }
}

async function getHistory(uid, sessionId, limit = 20) {
  if (!db) return [];
  try {
    const snapshot = await db
      .collection('users')
      .doc(uid)
      .collection('chats')
      .doc(sessionId)
      .collection('messages')
      .orderBy('timestamp', 'asc')
      .limitToLast(limit)
      .get();
    return snapshot.docs.map((doc) => {
      const data = doc.data();
      return {
        role: data.role,
        content: data.content,
        timestamp: data.timestamp ? data.timestamp.toMillis() : null,
      };
    });
  } catch (err) {
    console.error('Error fetching history from Firestore:', err.message);
    return [];
  }
}

async function listSessions(uid, limit = 50) {
  if (!db) return [];
  try {
    const snapshot = await db
      .collection('users')
      .doc(uid)
      .collection('chats')
      .orderBy('updatedAt', 'desc')
      .limit(limit)
      .get();
    return snapshot.docs.map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        title: data.title || 'New chat',
        lastMessage: data.lastMessage || '',
        updatedAt: data.updatedAt ? data.updatedAt.toMillis() : null,
      };
    });
  } catch (err) {
    console.error('Error listing sessions from Firestore:', err.message);
    return [];
  }
}

// ---------- Routes ----------

// Health check (useful for Render) — intentionally public, no auth required.
app.get('/health', (req, res) => {
  res.json({ status: 'ok', firestore: !!db, authConfigured: admin.apps.length > 0 });
});

// Everything below this line requires a signed-in user.
app.use('/api', verifyAuth);

// List past chat sessions for the sidebar
app.get('/api/sessions', async (req, res) => {
  const sessions = await listSessions(req.uid, 50);
  res.json({ sessions });
});

// Get chat history for a session
app.get('/api/history/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const history = await getHistory(req.uid, sessionId, 50);
  res.json({ history });
});

// Delete a session and all of its messages
app.delete('/api/sessions/:sessionId', async (req, res) => {
  if (!db) {
    return res.status(503).json({ error: 'Firestore is not configured.' });
  }
  try {
    const { sessionId } = req.params;
    const chatRef = db.collection('users').doc(req.uid).collection('chats').doc(sessionId);
    await db.recursiveDelete(chatRef);
    res.json({ deleted: true });
  } catch (err) {
    console.error('Error deleting session:', err.message);
    res.status(500).json({ error: 'Failed to delete session.' });
  }
});

// Send a message, get an AI reply
app.post('/api/chat', async (req, res) => {
  try {
    const { message, sessionId } = req.body;

    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'message is required' });
    }
    const sid = sessionId || 'default-session';

    // Pull recent history for context (strip timestamp — the model doesn't need it)
    const priorHistory = await getHistory(req.uid, sid, 20);
    const contextMessages = priorHistory.map((m) => ({ role: m.role, content: m.content }));

    const messages = [
      {
        role: 'system',
        content: 'You are a helpful, friendly AI assistant. Keep answers concise and clear.',
      },
      ...contextMessages,
      { role: 'user', content: message },
    ];

    // Save the user's message immediately
    await saveMessage(req.uid, sid, 'user', message);

    // Call Groq
    const completion = await groq.chat.completions.create({
      model: GROQ_MODEL,
      messages,
      temperature: 0.7,
      max_tokens: 1024,
    });

    const reply = completion.choices?.[0]?.message?.content?.trim() || '(no response)';

    // Save assistant reply
    await saveMessage(req.uid, sid, 'assistant', reply);

    res.json({ reply, sessionId: sid });
  } catch (err) {
    console.error('Chat error:', err);
    res.status(500).json({ error: 'Something went wrong generating a response.' });
  }
});

// Fallback to index.html for the root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});