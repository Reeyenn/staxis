import admin from 'firebase-admin';

// Prevent duplicate initialization in Next.js hot reload
if (!admin.apps.length) {
  const clientEmail = process.env.FIREBASE_ADMIN_CLIENT_EMAIL;
  const privateKey  = process.env.FIREBASE_ADMIN_PRIVATE_KEY?.replace(/\\n/g, '\n');
  const projectId   = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;

  if (clientEmail && privateKey && projectId) {
    admin.initializeApp({
      credential: admin.credential.cert({ clientEmail, privateKey, projectId }),
    });
  } else {
    console.warn('Firebase Admin SDK not configured - admin features will be unavailable.');
  }
}

export default admin;
