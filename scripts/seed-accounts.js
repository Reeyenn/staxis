/**
 * Seed initial accounts into Firestore.
 * Run: node scripts/seed-accounts.js
 *
 * Creates two accounts:
 *   Reeyen — admin, access to all properties
 *   Jay    — owner, access to Comfort Suites Beaumont only
 */

require('dotenv').config({ path: '.env.local' });
const admin = require('firebase-admin');
const bcrypt = require('bcryptjs');

const privateKey = process.env.FIREBASE_ADMIN_PRIVATE_KEY?.replace(/\\n/g, '\n');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_ADMIN_CLIENT_EMAIL,
      privateKey,
    }),
  });
}

const db = admin.firestore();

const DATA_UID = 'yuUXoy6E8QSeEL6d51y8oXsHCKE3';
const COMFORT_SUITES_PID = 'CGnX9DYc4t0COdzn5ekA';

const accounts = [
  {
    username: 'reeyen',
    displayName: 'Reeyen Patel',
    password: 'Reeyen2004%%',
    role: 'admin',
    propertyAccess: ['*'],
  },
  {
    username: 'jay',
    displayName: 'Jay',
    password: 'Jay',
    role: 'owner',
    propertyAccess: [COMFORT_SUITES_PID],
  },
];

(async () => {
  for (const acct of accounts) {
    // Check if account already exists
    const existing = await db.collection('accounts')
      .where('username', '==', acct.username)
      .limit(1).get();

    if (!existing.empty) {
      console.log(`  SKIP (already exists): ${acct.username}`);
      continue;
    }

    const passwordHash = await bcrypt.hash(acct.password, 10);

    await db.collection('accounts').add({
      username: acct.username,
      displayName: acct.displayName,
      passwordHash,
      role: acct.role,
      propertyAccess: acct.propertyAccess,
      dataUid: DATA_UID,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    console.log(`  CREATED: ${acct.username} (${acct.role})`);
  }

  console.log('Done.');
  process.exit(0);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
