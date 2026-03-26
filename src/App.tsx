import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GoogleMap, LoadScript, Polyline } from "@react-google-maps/api";
import { initializeApp } from "firebase/app";
import {
  getAuth,
  onAuthStateChanged,
  signInAnonymously,
} from "firebase/auth";
import type { User } from "firebase/auth";
import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  Timestamp,
} from "firebase/firestore";

/**
 * =====================================================================================
 * PRODUCTIEKLARE MVP: Wegsegment-score app
 * =====================================================================================
 *
 * DOEL
 * -----
 * Deze app laat gebruikers wegsegmenten beoordelen op wegkwaliteit.
 * Voorbeeld:
 * - score 5  = mooi glad wegdek
 * - score 1  = slecht wegdek
 *
 * BELANGRIJKSTE FUNCTIES
 * ----------------------
 * 1. Google Maps als kaartlaag
 * 2. Multi-user via Firebase Authentication + Firestore
 * 3. Wegsegmenten tekenen als polyline
 * 4. Andere gebruikers kunnen hetzelfde segment beoordelen
 * 5. Segmenten krijgen automatisch een kleur op basis van de gemiddelde score
 * 6. Eenvoudige bescherming tegen dubbele beoordelingen van dezelfde gebruiker
 * 7. Samenvattende statistieken worden direct op het segment opgeslagen
 *    zodat de kaart snel blijft, ook als het aantal beoordelingen groeit
 *
 * PRODUCTIEKEUZES IN DEZE VERSIE
 * ------------------------------
 * In de eerste MVP werd voor elk segment telkens alle ratings opnieuw opgehaald.
 * Dat werkt voor een demo, maar is niet schaalbaar.
 *
 * In deze versie doen we het beter:
 * - Elk segment bewaart zelf:
 *   - ratingCount
 *   - scoreSum
 *   - avgScore
 * - Nieuwe beoordelingen worden transactioneel toegevoegd
 * - Per gebruiker bewaren we 1 document per segment in `userRatings`
 *   zodat dezelfde gebruiker zijn/haar score kan aanpassen zonder duplicaten
 *
 * FIRESTORE STRUCTUUR
 * -------------------
 * /segments/{segmentId}
 *   - path: {lat,lng}[]
 *   - createdBy: string
 *   - createdAt: timestamp
 *   - updatedAt: timestamp
 *   - ratingCount: number
 *   - scoreSum: number
 *   - avgScore: number
 *   - lastRatedAt: timestamp
 *
 * /segments/{segmentId}/userRatings/{userId}
 *   - userId: string
 *   - score: number
 *   - createdAt: timestamp
 *   - updatedAt: timestamp
 *
 * LET OP
 * -------
 * Dit is bewust één bestand gehouden zodat je het gemakkelijk kunt begrijpen,
 * kopiëren en testen. In een echte productie-app zou je dit meestal opdelen in:
 * - components/
 * - hooks/
 * - lib/firebase.ts
 * - services/segmentService.ts
 * - types/
 *
 * BENODIGD
 * --------
 * - Google Maps JavaScript API key
 * - Firebase project
 * - Firestore database
 * - Firebase Authentication met Anonymous sign-in ingeschakeld
 */

// =====================================================================================
// 1. CONFIGURATIE
// =====================================================================================
// Vervang onderstaande placeholders met jouw eigen Firebase- en Google Maps-gegevens.
// In productie zet je dit idealiter in environment variables.

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID
};

const GOOGLE_MAPS_API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;

// Firebase initialiseren.
const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);
const auth = getAuth(firebaseApp);

// =====================================================================================
// 2. TYPEDEFINITIES
// =====================================================================================

/**
 * Eenvoudig type voor een GPS-punt.
 */
type LatLngPoint = {
  lat: number;
  lng: number;
};

/**
 * Firestore-document van een wegsegment.
 */
type Segment = {
  id: string;
  path: LatLngPoint[];
  createdBy: string;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
  lastRatedAt?: Timestamp;
  ratingCount: number;
  scoreSum: number;
  avgScore: number;
};

/**
 * Een beoordeling van één gebruiker op één segment.
 *
 * Door userId als document-id te gebruiken, dwingen we effectief af:
 * - maximaal één beoordeling per gebruiker per segment
 * - een gebruiker kan later zijn score aanpassen
 */
type UserRating = {
  userId: string;
  score: number;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
};

// =====================================================================================
// 3. KAART- EN UI-CONSTANTEN
// =====================================================================================

/**
 * Grootte van de kaartcontainer.
 */
const mapContainerStyle = {
  width: "100%",
  height: "100vh",
};

/**
 * Startpunt van de kaart.
 * Hier staat hij nu op Amsterdam. Dat kun je aanpassen aan jouw regio.
 */
const defaultCenter = {
  lat: 52.3676,
  lng: 4.9041,
};

/**
 * Fallback-zoomniveau.
 *
 * Dit gebruiken we zolang de GPS-locatie van de gebruiker nog niet bekend is.
 */
const defaultZoom = 13;

/**
 * Zoomniveau zodra we de huidige GPS-locatie hebben gevonden.
 *
 * 16 is meestal prettig: duidelijk dichtbij, maar nog genoeg context zichtbaar.
 */
const userLocationZoom = 16;

/**
 * Score omzetten naar een herkenbare kleur.
 *
 * Interpretatie:
 * - groen = goede wegen
 * - rood  = slechte wegen
 */
const scoreToColor = (score: number) => {
  if (score >= 4.5) return "#16a34a"; // donkergroen
  if (score >= 3.5) return "#65a30d"; // groen/geel
  if (score >= 2.5) return "#eab308"; // geel
  if (score >= 1.5) return "#f97316"; // oranje
  return "#dc2626"; // rood
};

/**
 * Mensvriendelijke beschrijving bij een score.
 */
const scoreLabel = (score: number) => {
  if (score >= 4.5) return "Zeer glad";
  if (score >= 3.5) return "Goed";
  if (score >= 2.5) return "Redelijk";
  if (score >= 1.5) return "Slecht";
  return "Zeer slecht";
};

/**
 * Afronden voor nette weergave.
 */
const formatScore = (score: number) => Number(score || 0).toFixed(1);

// =====================================================================================
// 4. HULPFUNCTIES VOOR PATHS EN SEGMENTEN
// =====================================================================================

/**
 * Kleine validatie: een segment moet minstens 2 punten bevatten.
 */
function isValidPath(path: LatLngPoint[]) {
  return Array.isArray(path) && path.length >= 2;
}

/**
 * Eenvoudige, pragmatische duplicate-detectie.
 *
 * In een perfecte wereld zou je segmenten matchen aan echte wegen uit de
 * Google Roads API of een GIS-backend. Dat is geavanceerder.
 *
 * Voor deze productie-MVP gebruiken we een simpeler aanpak:
 * - vergelijk beginpunt en eindpunt
 * - als beide dicht genoeg bij een bestaand segment liggen,
 *   dan beschouwen we het als hetzelfde segment
 *
 * Dit werkt redelijk goed als gebruikers ongeveer dezelfde lijn tekenen.
 */
function distanceInMeters(a: LatLngPoint, b: LatLngPoint) {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;

  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);

  const value =
    sinDLat * sinDLat +
    Math.cos(lat1) * Math.cos(lat2) * sinDLng * sinDLng;

  const c = 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
  return R * c;
}

/**
 * Controleert of twee paden ongeveer hetzelfde wegsegment voorstellen.
 */
function areLikelySameSegment(a: LatLngPoint[], b: LatLngPoint[]) {
  if (!a.length || !b.length) return false;

  const aStart = a[0];
  const aEnd = a[a.length - 1];
  const bStart = b[0];
  const bEnd = b[b.length - 1];

  // Houd rekening met omgekeerde tekenrichting.
  const directMatch =
    distanceInMeters(aStart, bStart) < 20 && distanceInMeters(aEnd, bEnd) < 20;
  const reverseMatch =
    distanceInMeters(aStart, bEnd) < 20 && distanceInMeters(aEnd, bStart) < 20;

  return directMatch || reverseMatch;
}

// =====================================================================================
// 5. FIRESTORE-SERVICES
// =====================================================================================
// Deze functies bevatten de kernlogica voor opslaan en beoordelen.

/**
 * Haalt alle segmenten live op uit Firestore.
 *
 * Waarom `onSnapshot`?
 * - gebruikers zien elkaars wijzigingen direct
 * - ideaal voor een multi-user kaarttoepassing
 */
function subscribeToSegments(onData: (segments: Segment[]) => void) {
  const segmentsRef = collection(db, "segments");
  const q = query(segmentsRef, orderBy("lastRatedAt", "desc"));

  return onSnapshot(q, (snapshot) => {
    const rows: Segment[] = snapshot.docs.map((segmentDoc) => {
      const data = segmentDoc.data() as Omit<Segment, "id">;
      return {
        id: segmentDoc.id,
        path: data.path || [],
        createdBy: data.createdBy || "unknown",
        createdAt: data.createdAt,
        updatedAt: data.updatedAt,
        lastRatedAt: data.lastRatedAt,
        ratingCount: Number(data.ratingCount || 0),
        scoreSum: Number(data.scoreSum || 0),
        avgScore: Number(data.avgScore || 0),
      };
    });

    onData(rows);
  });
}

/**
 * Zoekt of een segment waarschijnlijk al bestaat.
 *
 * Opmerking:
 * Firestore kan niet slim geometrisch zoeken zonder extra indexstrategie.
 * Voor een beginner-vriendelijke MVP halen we de laatste segmenten op en
 * vergelijken we lokaal. Voor een grote productieomgeving zou je dit vervangen
 * door een geohash / tile-strategie of een echte geo-backend.
 */
async function findLikelyExistingSegment(path: LatLngPoint[]) {
  const segmentsRef = collection(db, "segments");
  const q = query(segmentsRef, orderBy("updatedAt", "desc"), limit(100));
  const snapshot = await getDocs(q);

  const match = snapshot.docs.find((segmentDoc) => {
    const data = segmentDoc.data() as Omit<Segment, "id">;
    return areLikelySameSegment(path, data.path || []);
  });

  if (!match) return null;

  const data = match.data() as Omit<Segment, "id">;
  return {
    id: match.id,
    path: data.path || [],
    createdBy: data.createdBy || "unknown",
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
    lastRatedAt: data.lastRatedAt,
    ratingCount: Number(data.ratingCount || 0),
    scoreSum: Number(data.scoreSum || 0),
    avgScore: Number(data.avgScore || 0),
  } as Segment;
}

/**
 * Maakt een nieuw segment aan met een eerste score.
 *
 * Als er al een vergelijkbaar segment bestaat, gebruiken we dat segment en
 * voegen we alleen de beoordeling toe.
 */
async function createSegmentWithInitialRating(path: LatLngPoint[], userId: string, score: number) {
  const existing = await findLikelyExistingSegment(path);

  if (existing) {
    await upsertUserRating(existing.id, userId, score);
    return existing.id;
  }

  const segmentRef = await addDoc(collection(db, "segments"), {
    path,
    createdBy: userId,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    lastRatedAt: serverTimestamp(),
    ratingCount: 0,
    scoreSum: 0,
    avgScore: 0,
  });

  await upsertUserRating(segmentRef.id, userId, score);
  return segmentRef.id;
}

/**
 * Voegt een beoordeling toe of werkt een bestaande beoordeling bij.
 *
 * Waarom een transaction?
 * - voorkomt race conditions als meerdere gebruikers tegelijk stemmen
 * - houdt `ratingCount`, `scoreSum` en `avgScore` consistent
 */
async function upsertUserRating(segmentId: string, userId: string, newScore: number) {
  if (newScore < 1 || newScore > 5) {
    throw new Error("Score moet tussen 1 en 5 liggen.");
  }

  const segmentRef = doc(db, "segments", segmentId);
  const ratingRef = doc(db, "segments", segmentId, "userRatings", userId);

  await runTransaction(db, async (transaction) => {
    const segmentSnap = await transaction.get(segmentRef);
    if (!segmentSnap.exists()) {
      throw new Error("Segment bestaat niet meer.");
    }

    const segment = segmentSnap.data() as Omit<Segment, "id">;
    const ratingSnap = await transaction.get(ratingRef);

    const currentCount = Number(segment.ratingCount || 0);
    const currentSum = Number(segment.scoreSum || 0);

    let nextCount = currentCount;
    let nextSum = currentSum;

    if (ratingSnap.exists()) {
      // Gebruiker had al een beoordeling; we vervangen de oude score.
      const existingRating = ratingSnap.data() as UserRating;
      const oldScore = Number(existingRating.score || 0);
      nextSum = currentSum - oldScore + newScore;

      transaction.update(ratingRef, {
        score: newScore,
        updatedAt: serverTimestamp(),
      });
    } else {
      // Eerste beoordeling van deze gebruiker op dit segment.
      nextCount = currentCount + 1;
      nextSum = currentSum + newScore;

      transaction.set(ratingRef, {
        userId,
        score: newScore,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }

    const avgScore = nextCount > 0 ? nextSum / nextCount : 0;

    transaction.update(segmentRef, {
      ratingCount: nextCount,
      scoreSum: nextSum,
      avgScore,
      updatedAt: serverTimestamp(),
      lastRatedAt: serverTimestamp(),
    });
  });
}

/**
 * Haalt de huidige gebruikersscore op voor het geselecteerde segment.
 *
 * Handig zodat de interface kan tonen of iemand al heeft gestemd.
 */
async function getMyRatingForSegment(segmentId: string, userId: string) {
  const ratingRef = doc(db, "segments", segmentId, "userRatings", userId);
  const snap = await getDoc(ratingRef);
  if (!snap.exists()) return null;
  return snap.data() as UserRating;
}

// =====================================================================================
// 6. UI-COMPONENTEN
// =====================================================================================

function TopBar({
  user,
  segmentCount,
}: {
  user: User | null;
  segmentCount: number;
}) {
  return (
    <div className="absolute left-4 top-4 z-10 max-w-xl rounded-2xl bg-white/95 p-4 shadow-2xl backdrop-blur">
      <div className="text-2xl font-bold">Wegsegment Score</div>
      <div className="mt-2 text-sm leading-6 text-slate-600">
        Klik op <strong>Tekenmodus</strong>, teken een wegsegment, en geef daarna
        een score van 1 t/m 5. Bestaande segmenten kleuren automatisch mee op
        basis van de gemiddelde beoordeling van alle gebruikers.
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
        <div className="rounded-2xl bg-slate-50 p-3">
          <div className="text-slate-500">Gebruiker</div>
          <div className="font-medium">{user ? user.uid.slice(0, 12) : "Verbinden..."}</div>
        </div>
        <div className="rounded-2xl bg-slate-50 p-3">
          <div className="text-slate-500">Segmenten</div>
          <div className="font-medium">{segmentCount}</div>
        </div>
      </div>
    </div>
  );
}

function ScoreLegend() {
  const rows = [
    ["#16a34a", "4.5 - 5.0", "Zeer glad"],
    ["#65a30d", "3.5 - 4.4", "Goed"],
    ["#eab308", "2.5 - 3.4", "Redelijk"],
    ["#f97316", "1.5 - 2.4", "Slecht"],
    ["#dc2626", "1.0 - 1.4", "Zeer slecht"],
  ] as const;

  return (
    <div className="absolute bottom-4 left-4 z-10 w-72 rounded-2xl bg-white/95 p-4 shadow-2xl backdrop-blur">
      <div className="mb-3 text-lg font-semibold">Legenda</div>
      <div className="space-y-2 text-sm">
        {rows.map(([color, range, label]) => (
          <div key={color} className="flex items-center gap-3">
            <div className="h-3 w-8 rounded-full" style={{ backgroundColor: color }} />
            <div className="flex-1">{label}</div>
            <div className="text-slate-500">{range}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function DrawToolbar({
  drawMode,
  setDrawMode,
  onLocateMe,
  locating,
}: {
  drawMode: boolean;
  setDrawMode: (value: boolean) => void;
  onLocateMe: () => void;
  locating: boolean;
}) {
  return (
    <div className="absolute left-1/2 top-4 z-10 -translate-x-1/2 rounded-2xl bg-white/95 p-2 shadow-2xl backdrop-blur">
      <div className="flex items-center gap-2">
        <button
          onClick={() => setDrawMode(!drawMode)}
          className={`rounded-xl px-4 py-2 text-sm font-medium transition ${
            drawMode
              ? "bg-blue-600 text-white"
              : "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
          }`}
        >
          {drawMode ? "Tekenmodus actief" : "Tekenmodus"}
        </button>

        <button
          onClick={onLocateMe}
          className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
        >
          {locating ? "Locatie zoeken..." : "Mijn locatie"}
        </button>
      </div>
    </div>
  );
}

function RightPanel({
  selectedSegment,
  myScore,
  onRate,
}: {
  selectedSegment: Segment | null;
  myScore: number | null;
  onRate: (score: number) => void;
}) {
  return (
    <div className="absolute right-4 top-4 z-10 w-80 rounded-2xl bg-white/95 p-4 shadow-2xl backdrop-blur">
      <div className="text-lg font-semibold">Segmentdetails</div>

      {!selectedSegment ? (
        <div className="mt-3 text-sm leading-6 text-slate-600">
          Klik op een gekleurd wegsegment om details te zien en je eigen score
          toe te voegen of te wijzigen.
        </div>
      ) : (
        <>
          <div className="mt-3 rounded-2xl bg-slate-50 p-3">
            <div className="text-sm text-slate-500">Gemiddelde score</div>
            <div className="mt-1 text-3xl font-bold">{formatScore(selectedSegment.avgScore)} / 5</div>
            <div className="mt-1 text-sm text-slate-600">{scoreLabel(selectedSegment.avgScore)}</div>
          </div>

          <div className="mt-3 grid grid-cols-2 gap-3">
            <div className="rounded-2xl bg-slate-50 p-3">
              <div className="text-sm text-slate-500">Beoordelingen</div>
              <div className="text-xl font-semibold">{selectedSegment.ratingCount}</div>
            </div>
            <div className="rounded-2xl bg-slate-50 p-3">
              <div className="text-sm text-slate-500">Jouw score</div>
              <div className="text-xl font-semibold">{myScore ?? "-"}</div>
            </div>
          </div>

          <div className="mt-4">
            <div className="mb-2 text-sm font-medium">Score geven of wijzigen</div>
            <div className="grid grid-cols-5 gap-2">
              {[1, 2, 3, 4, 5].map((score) => (
                <button
                  key={score}
                  onClick={() => onRate(score)}
                  className={`rounded-xl border px-3 py-2 text-sm font-medium transition ${
                    myScore === score
                      ? "border-blue-600 bg-blue-600 text-white"
                      : "border-slate-200 hover:border-slate-400 hover:bg-slate-50"
                  }`}
                >
                  {score}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// =====================================================================================
// 7. HOOFDCOMPONENT
// =====================================================================================

export default function RoadSegmentScoreApp() {
  // Ingelogde gebruiker.
  const [user, setUser] = useState<User | null>(null);

  // Alle segmenten op de kaart.
  const [segments, setSegments] = useState<Segment[]>([]);

  // Geselecteerd segment in de rechter zijbalk.
  const [selectedSegment, setSelectedSegment] = useState<Segment | null>(null);

  // Huidige score van de ingelogde gebruiker voor het geselecteerde segment.
  const [myScore, setMyScore] = useState<number | null>(null);

  // Laad- en foutstatussen voor nette UX.
  const [saving, setSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Tekenmodus staat standaard uit zodat klikken op segmenten makkelijk blijft.
  const [drawMode, setDrawMode] = useState(false);

  // Middenpunt en zoomniveau van de kaart.
  // We starten in Amsterdam, maar proberen direct daarna naar de GPS-locatie te gaan.
  const [mapCenter, setMapCenter] = useState(defaultCenter);
  const [mapZoom, setMapZoom] = useState(defaultZoom);
  const [locating, setLocating] = useState(false);

  // Referentie naar het kaartobject, zodat we listeners kunnen registreren.
  const mapRef = useRef<google.maps.Map | null>(null);

  // -----------------------------------------------------------------------------------
  // AUTHENTICATIE
  // -----------------------------------------------------------------------------------
  // We gebruiken anonieme login omdat dat beginner-vriendelijk is.
  // Later kun je dit vervangen door Google Sign-In of e-mail login.
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      try {
        if (currentUser) {
          setUser(currentUser);
        } else {
          await signInAnonymously(auth);
        }
      } catch (error) {
        console.error(error);
        setErrorMessage("Inloggen is mislukt. Controleer Firebase Authentication.");
      }
    });

    return () => unsubscribe();
  }, []);

  // -----------------------------------------------------------------------------------
  // LIVE SEGMENTEN OPHALEN
  // -----------------------------------------------------------------------------------
  useEffect(() => {
    const unsubscribe = subscribeToSegments((rows) => {
      setSegments(rows);

      // Zorg dat een al geselecteerd segment netjes wordt ververst.
      setSelectedSegment((current) => {
        if (!current) return null;
        return rows.find((row) => row.id === current.id) || null;
      });
    });

    return () => unsubscribe();
  }, []);

  // -----------------------------------------------------------------------------------
  // EIGEN SCORE OPHALEN VOOR GESELECTEERD SEGMENT
  // -----------------------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;

    async function loadMyRating() {
      if (!selectedSegment || !user) {
        setMyScore(null);
        return;
      }

      try {
        const rating = await getMyRatingForSegment(selectedSegment.id, user.uid);
        if (!cancelled) {
          setMyScore(rating?.score ?? null);
        }
      } catch (error) {
        console.error(error);
        if (!cancelled) {
          setErrorMessage("Je beoordeling kon niet worden geladen.");
        }
      }
    }

    loadMyRating();

    return () => {
      cancelled = true;
    };
  }, [selectedSegment, user]);

  // -----------------------------------------------------------------------------------
  // KAARTOPTIES
  // -----------------------------------------------------------------------------------
  const mapOptions = useMemo<google.maps.MapOptions>(
    () => ({
      streetViewControl: false,
      mapTypeControl: true,
      fullscreenControl: true,
      clickableIcons: false,
      gestureHandling: "greedy",
      mapTypeId: "roadmap",
      zoomControl: true,
    }),
    []
  );

  // -----------------------------------------------------------------------------------
  // HUIDIGE GPS-LOCATIE OPHALEN EN KAART DAAROP CENTREREN
  // -----------------------------------------------------------------------------------
  const locateUser = useCallback(() => {
    if (!navigator.geolocation) {
      setErrorMessage("Je browser ondersteunt geen GPS-locatie.");
      return;
    }

    setLocating(true);
    setErrorMessage(null);

    navigator.geolocation.getCurrentPosition(
      (position) => {
        const nextCenter = {
          lat: position.coords.latitude,
          lng: position.coords.longitude,
        };

        setMapCenter(nextCenter);
        setMapZoom(userLocationZoom);

        if (mapRef.current) {
          mapRef.current.panTo(nextCenter);
          mapRef.current.setZoom(userLocationZoom);
        }

        setLocating(false);
      },
      (error) => {
        console.error(error);

        let message = "Je locatie kon niet worden opgehaald.";
        if (error.code === error.PERMISSION_DENIED) {
          message = "Locatietoegang is geweigerd. Sta locatiegebruik toe in je browser.";
        } else if (error.code === error.POSITION_UNAVAILABLE) {
          message = "Je locatie is nu niet beschikbaar.";
        } else if (error.code === error.TIMEOUT) {
          message = "Het ophalen van je locatie duurde te lang.";
        }

        setErrorMessage(message);
        setLocating(false);
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 60000,
      }
    );
  }, []);

  // Vraag bij het openen van de app meteen de huidige locatie op.
  useEffect(() => {
    locateUser();
  }, [locateUser]);

  // -----------------------------------------------------------------------------------
  // NIEUW SEGMENT TEKENEN VIA KLIKKEN OP DE KAART
  // -----------------------------------------------------------------------------------
  // Waarom niet DrawingManager?
  // - dit geeft ons meer controle
  // - minder afhankelijkheden
  // - makkelijker aanpasbaar voor productie
  const drawingPointsRef = useRef<LatLngPoint[]>([]);
  const drawingPreviewRef = useRef<google.maps.Polyline | null>(null);
  const clickListenerRef = useRef<google.maps.MapsEventListener | null>(null);
  const dblClickListenerRef = useRef<google.maps.MapsEventListener | null>(null);

  const cleanupDrawingListeners = useCallback(() => {
    if (clickListenerRef.current) {
      clickListenerRef.current.remove();
      clickListenerRef.current = null;
    }
    if (dblClickListenerRef.current) {
      dblClickListenerRef.current.remove();
      dblClickListenerRef.current = null;
    }
  }, []);

  const resetDrawing = useCallback(() => {
    drawingPointsRef.current = [];
    if (drawingPreviewRef.current) {
      drawingPreviewRef.current.setMap(null);
      drawingPreviewRef.current = null;
    }
  }, []);

  const completeDrawing = useCallback(async () => {
    if (!user) {
      setErrorMessage("Je bent nog niet ingelogd.");
      return;
    }

    const path = [...drawingPointsRef.current];
    if (!isValidPath(path)) {
      resetDrawing();
      return;
    }

    const rawValue = window.prompt("Geef een score voor dit segment (1 t/m 5):", "3");
    const score = Number(rawValue);

    if (!Number.isFinite(score) || score < 1 || score > 5) {
      setErrorMessage("Ongeldige score. Gebruik een getal tussen 1 en 5.");
      resetDrawing();
      return;
    }

    setSaving(true);
    setErrorMessage(null);

    try {
      const createdOrMatchedSegmentId = await createSegmentWithInitialRating(path, user.uid, score);
      const freshSegment = segments.find((segment) => segment.id === createdOrMatchedSegmentId);
      if (freshSegment) setSelectedSegment(freshSegment);
      setDrawMode(false);
    } catch (error) {
      console.error(error);
      setErrorMessage("Opslaan van het wegsegment is mislukt.");
    } finally {
      resetDrawing();
      setSaving(false);
    }
  }, [resetDrawing, segments, user]);

  useEffect(() => {
    if (!mapRef.current || !drawMode) {
      cleanupDrawingListeners();
      resetDrawing();
      return;
    }

    const map = mapRef.current;

    // Voorvertoning van het getekende segment.
    drawingPreviewRef.current = new google.maps.Polyline({
      map,
      path: [],
      strokeColor: "#2563eb",
      strokeOpacity: 0.95,
      strokeWeight: 6,
      clickable: false,
    });

    clickListenerRef.current = map.addListener("click", (event: google.maps.MapMouseEvent) => {
      if (!event.latLng) return;

      drawingPointsRef.current = [
        ...drawingPointsRef.current,
        { lat: event.latLng.lat(), lng: event.latLng.lng() },
      ];

      drawingPreviewRef.current?.setPath(drawingPointsRef.current);
    });

    // Dubbelklik = tekenen afronden.
    dblClickListenerRef.current = map.addListener("dblclick", async (event: google.maps.MapMouseEvent) => {
      // Standaard zoomt Google Maps bij dubbelklik. Die actie willen we hier niet.
      if (event.domEvent && "preventDefault" in event.domEvent) {
        event.domEvent.preventDefault();
      }
      await completeDrawing();
    });

    return () => {
      cleanupDrawingListeners();
      resetDrawing();
    };
  }, [cleanupDrawingListeners, completeDrawing, drawMode, resetDrawing]);

  // -----------------------------------------------------------------------------------
  // BESTAAND SEGMENT BEOORDELEN
  // -----------------------------------------------------------------------------------
  const handleRateSelectedSegment = useCallback(
    async (score: number) => {
      if (!selectedSegment || !user) return;

      setSaving(true);
      setErrorMessage(null);

      try {
        await upsertUserRating(selectedSegment.id, user.uid, score);
        setMyScore(score);
      } catch (error) {
        console.error(error);
        setErrorMessage("Je beoordeling kon niet worden opgeslagen.");
      } finally {
        setSaving(false);
      }
    },
    [selectedSegment, user]
  );

  // -----------------------------------------------------------------------------------
  // RENDER
  // -----------------------------------------------------------------------------------
  return (
    <div className="relative h-screen w-full bg-slate-100">
      <LoadScript googleMapsApiKey={GOOGLE_MAPS_API_KEY}>
        <GoogleMap
          mapContainerStyle={mapContainerStyle}
          center={mapCenter}
          zoom={mapZoom}
          options={mapOptions}
          onLoad={(map) => {
            mapRef.current = map;
          }}
          onUnmount={() => {
            mapRef.current = null;
          }}
        >
          {segments.map((segment) => (
            <Polyline
              key={segment.id}
              path={segment.path}
              options={{
                strokeColor: scoreToColor(segment.avgScore || 1),
                strokeOpacity: 0.95,
                strokeWeight: selectedSegment?.id === segment.id ? 8 : 6,
                zIndex: selectedSegment?.id === segment.id ? 1000 : 1,
              }}
              onClick={() => {
                setSelectedSegment(segment);
                setDrawMode(false);
              }}
            />
          ))}
        </GoogleMap>
      </LoadScript>

      <TopBar user={user} segmentCount={segments.length} />
      <DrawToolbar
        drawMode={drawMode}
        setDrawMode={setDrawMode}
        onLocateMe={locateUser}
        locating={locating}
      />
      <RightPanel selectedSegment={selectedSegment} myScore={myScore} onRate={handleRateSelectedSegment} />
      <ScoreLegend />

      {drawMode && (
        <div className="absolute bottom-24 left-1/2 z-10 -translate-x-1/2 rounded-full bg-blue-600 px-4 py-2 text-sm text-white shadow-xl">
          Klik op de kaart om punten toe te voegen. Dubbelklik om af te ronden.
        </div>
      )}

      {saving && (
        <div className="absolute inset-x-0 bottom-4 z-10 mx-auto w-fit rounded-full bg-slate-900 px-4 py-2 text-sm text-white shadow-lg">
          Opslaan...
        </div>
      )}

      {errorMessage && (
        <div className="absolute inset-x-0 bottom-16 z-10 mx-auto w-fit max-w-xl rounded-2xl bg-red-600 px-4 py-3 text-sm text-white shadow-lg">
          {errorMessage}
        </div>
      )}
    </div>
  );
}

/**
 * =====================================================================================
 * 8. AANBEVOLEN FIRESTORE SECURITY RULES
 * =====================================================================================
 *
 * Plaats deze regels in Firestore Rules.
 * Let op: dit is geen TypeScript-code maar Firestore Rules-syntax.
 *
 * rules_version = '2';
 * service cloud.firestore {
 *   match /databases/{database}/documents {
 *
 *     function isSignedIn() {
 *       return request.auth != null;
 *     }
 *
 *     function validScore() {
 *       return request.resource.data.score is number
 *         && request.resource.data.score >= 1
 *         && request.resource.data.score <= 5;
 *     }
 *
 *     match /segments/{segmentId} {
 *       allow read: if true;
 *
 *       // Segment aanmaken: alleen ingelogde gebruikers.
 *       allow create: if isSignedIn()
 *         && request.resource.data.path is list
 *         && request.resource.data.path.size() >= 2
 *         && request.resource.data.createdBy == request.auth.uid;
 *
 *       // Rechtstreeks updaten van segmenten vanaf client beperken.
 *       // In deze MVP updaten we segmenten vanuit de app zelf.
 *       // In een strengere architectuur laat je alleen Cloud Functions updaten.
 *       allow update: if isSignedIn();
 *
 *       match /userRatings/{userId} {
 *         allow read: if isSignedIn();
 *         allow create, update: if isSignedIn()
 *           && request.auth.uid == userId
 *           && request.resource.data.userId == request.auth.uid
 *           && validScore();
 *       }
 *     }
 *   }
 * }
 *
 * Voor échte productie raad ik aan om score-berekeningen via Cloud Functions te doen.
 * Dan kun je segment-updates door clients blokkeren en wordt alles veiliger.
 * =====================================================================================
 */
