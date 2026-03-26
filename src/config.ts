// ----------------------------------------------------------------------------------
// CONFIG - haalt alle environment variables uit .env
// ----------------------------------------------------------------------------------

/**
 * Firebase configuratie
 * Deze waarden komen uit je .env bestand via Vite
 */
export const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

/**
 * Google Maps API key
 */
export const GOOGLE_MAPS_API_KEY =
  import.meta.env.VITE_GOOGLE_MAPS_API_KEY;

/**
 * Kleine helper om te checken of alles geladen is
 * (handig tijdens development)
 */
export function validateEnv() {
  const required = [
    "VITE_FIREBASE_API_KEY",
    "VITE_FIREBASE_AUTH_DOMAIN",
    "VITE_FIREBASE_PROJECT_ID",
    "VITE_GOOGLE_MAPS_API_KEY",
  ];

  required.forEach((key) => {
    if (!import.meta.env[key]) {
      console.error(`❌ Missing environment variable: ${key}`);
    }
  });
}