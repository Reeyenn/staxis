import { NextRequest, NextResponse } from 'next/server';
import admin from '@/lib/firebase-admin';
import bcrypt from 'bcryptjs';

export async function POST(req: NextRequest) {
  try {
    const { username, password } = await req.json();

    if (!username || !password) {
      return NextResponse.json({ error: 'Username and password required' }, { status: 400 });
    }

    const db = admin.firestore();

    // Case-insensitive username lookup
    const snap = await db.collection('accounts')
      .where('username', '==', username.toLowerCase().trim())
      .limit(1)
      .get();

    if (snap.empty) {
      return NextResponse.json({ error: 'Invalid username or password' }, { status: 401 });
    }

    const docSnap = snap.docs[0];
    const account = docSnap.data();

    // Verify password
    const passwordValid = await bcrypt.compare(password, account.passwordHash);
    if (!passwordValid) {
      return NextResponse.json({ error: 'Invalid username or password' }, { status: 401 });
    }

    // Create custom Firebase Auth token tied to the account's data UID
    const customToken = await admin.auth().createCustomToken(account.dataUid);

    return NextResponse.json({
      customToken,
      account: {
        accountId: docSnap.id,
        username: account.username,
        displayName: account.displayName,
        role: account.role,
        propertyAccess: account.propertyAccess,
        dataUid: account.dataUid,
      },
    });
  } catch (err) {
    console.error('Login error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
