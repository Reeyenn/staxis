/**
 * Delete duplicate properties for a given user, keeping only the specified one.
 *
 * Run: node scripts/delete-duplicate-property.js
 */

require('dotenv').config({ path: '.env.local' });
const admin = require('firebase-admin');

const privateKey = process.env.FIREBASE_ADMIN_PRIVATE_KEY?.replace(/\\n/g, '\n');

admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_ADMIN_CLIENT_EMAIL,
    privateKey,
  }),
});

const db = admin.firestore();

const UID       = 'yuUXoy6E8QSeEL6d51y8oXsHCKE3';
const KEEP_ID   = 'CGnX9DYc4t0COdzn5ekA';

async function deleteSubcollections(docRef) {
  const subcols = await docRef.listCollections();
  for (const col of subcols) {
    const snap = await col.get();
    for (const doc of snap.docs) {
      await deleteSubcollections(doc.ref);
      await doc.ref.delete();
    }
  }
}

(async () => {
  const propsSnap = await db.collection(`users/${UID}/properties`).get();
  console.log(`Found ${propsSnap.size} properties under user ${UID}`);

  for (const doc of propsSnap.docs) {
    if (doc.id === KEEP_ID) {
      console.log(`  KEEP: ${doc.id} — "${doc.data().name}"`);
      continue;
    }
    console.log(`  DELETE: ${doc.id} — "${doc.data().name}"`);
    await deleteSubcollections(doc.ref);
    await doc.ref.delete();
    console.log(`    ✓ Deleted`);
  }

  console.log('Done.');
  process.exit(0);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
