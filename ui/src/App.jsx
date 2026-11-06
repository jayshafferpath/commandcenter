import { useEffect, useState } from "react";
import { FocusBoard } from "./FocusBoard.jsx";
import { BrainPage } from "./BrainPage.jsx";

// Hash routing rather than paths: the built UI is static files with no
// server-side fallback, so #/brain/<id> survives a reload where
// /brain/<id> would 404.
const BRAIN_ROUTE = /^#\/brain\/([^/]+)$/;

function useHash() {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return hash;
}

export function App() {
  const brainJobId = useHash().match(BRAIN_ROUTE)?.[1];
  return brainJobId ? <BrainPage jobId={brainJobId} /> : <FocusBoard />;
}
