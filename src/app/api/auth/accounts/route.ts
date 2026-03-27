import { NextRequest, NextResponse } from 'next/server';
import admin from '@/lib/firebase-admin';
import bcrypt from 'bcryptjs';

// All accounts share this data UID for Firestore path access.
// When supporting multiple hotel owners in the future, this would be per-account.
const DEFAULT_DATA_UID = 'yuUXoy6E8QSeEL6d51y8oXsHCKE3';

async function verifyAdmin(req: NextRequest) {
  const accountId = req.headers.get('x-account-id');
  if (!accountId) return null;
  const db = admin.firestore();
  const doc = await db.collection('accounts').doc(accountId).get();
  if (!doc.exists || doc.data()?.role !== 'admin') return null;
  return doc;
}

// GET /api/auth/accounts — list all accounts (admin only)
export async function GET(req: NextRequest) {
  const caller = await verifyAdmin(req);
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });

  const db = admin.firestore();
  const snap = await db.collection('accounts').get();
  const accounts = snap.docs.map(d => {
    const data = d.data();
    return {
      accountId: d.id,
      username: data.username,
      displayName: data.displayName,
      role: data.role,
      propertyAccess: data.propertyAccess,
      createdAt: data.createdAt?.toDate?.().toISOString() ?? null,
    };
  });

  return NextResponse.json({ accounts });
}

// POST /api/auth/accounts — create account (admin only)
export async function POST(req: NextRequest) {
  const caller = await verifyAdmin(req);
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });

  const { username, password, displayName, role, propertyAccess } = await req.json();

  if (!username || !password || !role) {
    return NextResponse.json({ error: 'username, password, and role are required' }, { status: 400 });
  }

  const db = admin.firestore();

  // Check duplicate username
  const existing = await db.collection('accounts')
    .where('username', '==', username.toLowerCase().trim())
    .limit(1).get();
  if (!existing.empty) {
    return NextResponse.json({ error: 'Username already exists' }, { status: 409 });
  }

  const passwordHash = await bcrypt.hash(password, 10);

  const docRef = await db.collection('accounts').add({
    username: username.toLowerCase().trim(),
    displayName: displayName || username,
    passwordHash,
    role,
    propertyAccess: propertyAccess ?? [],
    dataUid: DEFAULT_DATA_UID,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return NextResponse.json({ accountId: docRef.id });
}

// PUT /api/auth/accounts — update account (admin only)
export async function PUT(req: NextRequest) {
  const caller = await verifyAdmin(req);
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });

  const { accountId, displayName, role, propertyAccess, password } = await req.json();
  if (!accountId) return NextResponse.json({ error: 'accountId required' }, { status: 400 });

  const updates: Record<string, unknown> = {};
  if (displayName !== undefined) updates.displayName = displayName;
  if (role !== undefined) updates.role = role;
  if (propertyAccess !== undefined) updates.propertyAccess = propertyAccess;
  if (password) updates.passwordHash = await bcrypt.hash(password, 10);

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'Nothing to update' }, { status: 400 });
  }

  const db = admin.firestore();
  await db.collection('accounts').doc(accountId).update(updates);

  return NextResponse.json({ success: true });
}

// DELETE /api/auth/accounts?accountId=xxx — delete account (admin only)
export async function DELETE(req: NextRequest) {
  const caller = await verifyAdmin(req);
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });

  const { searchParams } = new URL(req.url);
  const accountId = searchParams.get('accountId');
  if (!accountId) return NextResponse.json({ error: 'accountId required' }, { status: 400 });

  // Prevent deleting own account
  if (accountId === caller.id) {
    return NextResponse.json({ error: 'Cannot delete your own account' }, { status: 400 });
  }

  const db = admin.firestore();
  await db.collection('accounts').doc(accountId).delete();

  return NextResponse.json({ success: true });
}
