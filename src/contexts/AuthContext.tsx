'use client';

import React, { createContext, useContext, useEffect, useState } from 'react';
import {
  onAuthStateChanged,
  signInWithCustomToken,
  signOut as firebaseSignOut,
} from 'firebase/auth';
import { auth } from '@/lib/firebase';

export interface AppUser {
  uid: string;               // data-path UID used for all Firestore queries
  accountId: string;         // Firestore accounts/{accountId}
  username: string;          // lowercase username
  displayName: string;
  role: 'admin' | 'owner' | 'staff';
  propertyAccess: string[];  // ["*"] = all properties, ["pid"] = specific access
}

interface AuthContextType {
  user: AppUser | null;
  loading: boolean;
  /** Returns an error string on failure, or null on success */
  signIn: (username: string, password: string) => Promise<string | null>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  loading: true,
  signIn: async () => null,
  signOut: async () => {},
});

const ACCOUNT_KEY = 'hotelops-account';

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AppUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      if (firebaseUser && !firebaseUser.isAnonymous) {
        const stored = typeof window !== 'undefined'
          ? localStorage.getItem(ACCOUNT_KEY)
          : null;

        if (stored) {
          try {
            const account = JSON.parse(stored) as AppUser;
            if (account.uid === firebaseUser.uid) {
              setUser(account);
            } else {
              // UID mismatch - stale session, clear it
              localStorage.removeItem(ACCOUNT_KEY);
              await firebaseSignOut(auth);
              setUser(null);
            }
          } catch {
            localStorage.removeItem(ACCOUNT_KEY);
            setUser(null);
          }
        } else {
          // Firebase session exists with no account info - sign out
          await firebaseSignOut(auth);
          setUser(null);
        }
      } else {
        // null or anonymous user - not a manager session
        setUser(null);
      }
      setLoading(false);
    });
    return unsubscribe;
  }, []);

  const signIn = async (username: string, password: string): Promise<string | null> => {
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });

      const data = await res.json();

      if (!res.ok) {
        return data.error ?? 'Login failed';
      }

      const { customToken, account } = data as {
        customToken: string;
        account: { accountId: string; username: string; displayName: string; role: AppUser['role']; propertyAccess: string[]; dataUid: string };
      };

      const appUser: AppUser = {
        uid: account.dataUid,
        accountId: account.accountId,
        username: account.username,
        displayName: account.displayName,
        role: account.role,
        propertyAccess: account.propertyAccess,
      };

      // Store account info BEFORE signing in - onAuthStateChanged will read it
      localStorage.setItem(ACCOUNT_KEY, JSON.stringify(appUser));

      // Sign in with custom Firebase token (establishes Firebase session for Firestore rules)
      await signInWithCustomToken(auth, customToken);

      return null; // success
    } catch (err) {
      console.error('signIn error:', err);
      return 'An error occurred. Please try again.';
    }
  };

  const signOut = async () => {
    sessionStorage.removeItem('hotelops-session-selected');
    localStorage.removeItem(ACCOUNT_KEY);
    await firebaseSignOut(auth);
  };

  return (
    <AuthContext.Provider value={{ user, loading, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
