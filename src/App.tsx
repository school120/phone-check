import React, { useEffect, useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";

// ---------- Types ----------
interface RosterRow {
  personId: string;
  fullName: string;
  securityNumber: string;
  currentGrade?: string;
}
interface DetectionRow {
  slot: number;
  securityNumber: string;
  phonePresent: boolean;
  presenceScore: number;
  satScore: number;
  confidence: number;
  color: string;
}
type Status = "TURNED_IN" | "MISSING" | "UNASSIGNED" | "SUSPICIOUS";
interface JoinedRow extends DetectionRow {
  personId?: string;
  fullName?: string;
  currentGrade?: string;
  status: Status;
  expectedColor?: string | null;
}
interface DeviceProfile {
  securityNumber: string;
  color: string;
  lastUpdated: string;
}

// ---------- Constants ----------
const BOX_OPTIONS = ["A", "B", "C", "D", "E", "F", "SM1", "SM2"] as const;
const GRADES = [9, 10, 11, 12] as const;
const ROWS = 5;
const COLS = 12;
const LS_KEY = "deviceProfiles.v1";

// ---------- Helpers ----------
function buildSecurityNumber(grade: number, box: string, slot: number) {
  const b = box.toUpperCase();
  if (b === "SM1" || b === "SM2") return `${b}-${slot}`;
  return `${grade}${b}${slot}`;
}
function toCSV(rows: JoinedRow[]) {
  const header = [
    "Slot","Security Number","Full Name","Person ID","Current Grade",
    "Present","Presence Score","Saturation","Confidence","Detected Color","Expected Color","Status",
  ];
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push([
      r.slot,
      r.securityNumber,
      r.fullName ?? "",
      r.personId ?? "",
      r.currentGrade ?? "",
      r.phonePresent ? "Yes" : "No",
      r.presenceScore.toFixed(3),
      r.satScore.toFixed(3),
      r.confidence.toFixed(3),
      r.color,
      r.expectedColor ?? "",
      r.status,
    ].join(","));
  }
  return lines.join("\n");
}
function downloadText(filename: string, mime: string, text: string) {
  const blob = new Blob([text], { type: `${mime};charset=utf-8;` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
function downloadCSV(filename: string, text: string) {
  downloadText(filename, "text/csv", text);
}
function downloadJSON(filename: string, obj: any) {
  downloadText(filename, "application/json", JSON.stringify(obj, null, 2));
}
function colorLabelFromHSV(h: number, s255: number, v255: number): string {
  if (s255 < 40 && v255 < 120) return "black";
  if (s255 < 40) return "gray";
  if (h < 10 || h > 170) return "red";
  if (h < 25) return "orange/brown";
  if (h < 35) return "yellow/gold";
  if (h < 85) return "green";
  if (h < 130) return "blue";
  return "purple";
}

// ---------- Component ----------
export default function App() {
  const [roster, setRoster] = useState<RosterRow[]>([]);
  const [rosterError, setRosterError] = useState<string | null>(null);

  const [grade, setGrade] = useState<number>(9);
  const [box, setBox] = useState<string>("A");

  const [cropTop, setCropTop] = useState(9);
  const [cropLeft, setCropLeft] = useState(19);
  const [cropRight, setCropRight] = useState(83);
  const [cropBottom, setCropBottom] = useState(92);
  const [darkRatioMin, setDarkRatioMin] = useState(0.40);
  const [satMin, setSatMin] = useState(0.20);

  const [imageFile, setImageFile] = useState<File | null>(null);
  const [results, setResults] = useState<JoinedRow[] | null>(null);

  const imgRef = useRef<HTMLImageElement | null>(null);
  const scanCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);

  // -------- Load roster --------
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`${process.env.PUBLIC_URL}/roster.xlsx`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = await res.arrayBuffer();
        const wb = XLSX.read(buf);
        const ws = wb.Sheets[wb.SheetNames[0]];
        const json: any[] = XLSX.utils.sheet_to_json(ws, { defval: "" });
        const normalized: RosterRow[] = json.map((r) => ({
          personId: String(r["Person ID"] ?? ""),
          fullName: String(r["Full Name"] ?? ""),
          securityNumber: String(r["Security Number"] ?? "").toUpperCase().trim(),
          currentGrade: String(r["Current Grade"] ?? ""),
        }));
        setRoster(normalized);
        setRosterError(null);
      } catch (e) {
        console.error("Failed to load roster:", e);
        setRosterError("Couldn't load roster.xlsx from /public. Make sure the file exists in the repo.");
      }
    })();
  }, []);

  // -------- Grid overlay --------
  const drawOverlay = () => {
    const img = imgRef.current;
    const overlay = overlayRef.current;
    if (!img || !overlay) return;

    const w = img.clientWidth;
    const h = img.clientHeight;
    if (!w || !h) return;

    overlay.width = w;
    overlay.height = h;
    const ctx = overlay.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);

    const L = Math.round((cropLeft / 100) * w);
    const R = Math.round((cropRight / 100) * w);
    const T = Math.round((cropTop / 100) * h);
    const B = Math.round((cropBottom / 100) * h);

    ctx.strokeStyle = "rgba(0,200,0,0.95)";
    ctx.strokeRect(L, T, R - L, B - T);
  };

  useEffect(() => {
    drawOverlay();
    window.addEventListener("resize", drawOverlay);
    return () => window.removeEventListener("resize", drawOverlay);
  }, [imageFile, cropTop, cropLeft, cropRight, cropBottom]);

  const counts = useMemo(() => ({
    turnedIn: results?.filter(r => r.status === "TURNED_IN").length ?? 0,
    missing: results?.filter(r => r.status === "MISSING").length ?? 0,
    unassigned: results?.filter(r => r.status === "UNASSIGNED").length ?? 0,
  }), [results]);

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <h1 className="text-2xl font-bold">Phone Check – Grades 9–12 (A–F, SM1/SM2)</h1>
      {rosterError && (
        <div className="p-3 rounded-lg bg-red-50 text-red-700 text-sm">{rosterError}</div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="p-4 bg-white rounded-2xl shadow">
          <label className="block text-sm font-medium">Take Picture</label>
          <input
            type="file"
            accept="image/*"
            capture="environment"
            onChange={(e) => { setImageFile(e.target.files?.[0] ?? null); setResults(null); setTimeout(drawOverlay, 0); }}
            className="block w-full"
          />
        </div>

        <div className="p-4 bg-white rounded-2xl shadow">
          <div className="text-sm font-medium">Preview & Grid</div>
          <div className="relative border rounded-xl overflow-hidden">
            {imageFile ? (
              <>
                <img
                  ref={imgRef}
                  src={URL.createObjectURL(imageFile)}
                  alt="box"
                  onLoad={drawOverlay}
                  className="max-h-[480px] w-full object-contain block"
                />
                <canvas ref={overlayRef} className="absolute inset-0 w-full h-full pointer-events-none" />
              </>
            ) : (
              <div className="h-64 flex items-center justify-center text-gray-400">
                Take a photo to preview
              </div>
            )}
            <canvas ref={scanCanvasRef} className="hidden" />
          </div>
        </div>
      </div>

      {results && (
        <div className="p-4 bg-white rounded-2xl shadow">
          <div>Summary: ✅ {counts.turnedIn} ❌ {counts.missing} — {counts.unassigned}</div>
        </div>
      )}
    </div>
  );
}
