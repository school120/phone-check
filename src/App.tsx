import React, { useEffect, useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";

// ---------- Types ----------
interface RosterRow {
  personId: string;
  fullName: string;
  securityNumber: string; // e.g., 9A23, 10F12, SM1-7, SM2-23
  currentGrade?: string;
}
interface DetectionRow {
  slot: number;
  securityNumber: string;
  phonePresent: boolean;
  presenceScore: number; // dark pixel ratio below Otsu threshold (0..1)
  satScore: number;      // average saturation (0..1)
  confidence: number;    // combined score (0..1)
  color: string;         // coarse color label learned from this photo
}
type Status = "TURNED_IN" | "MISSING" | "UNASSIGNED" | "SUSPICIOUS";
interface JoinedRow extends DetectionRow {
  personId?: string;
  fullName?: string;
  currentGrade?: string;
  status: Status;
  expectedColor?: string | null; // saved baseline (from prior scans you approved or auto-learned)
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
/** Accepts:
 *  • Grade + box A–F:  "9A23", "10F12"
 *  • Standalone SM:    "SM1-23", "SM2-9" (hyphen optional; spaces ignored)
 */
function parseSecurityNumber(sn: string) {
  const s = sn?.toString().trim().toUpperCase().replace(/\s+/g, "");
  if (!s) return null;

  const sm = s.match(/^(SM1|SM2)-?(\d{1,3})$/);
  if (sm) return { grade: null as unknown as number, box: sm[1], slot: parseInt(sm[2], 10) };

  const gb = s.match(/^(\d{1,2})([ABCDEF])(\d{1,3})$/);
  if (gb) return { grade: parseInt(gb[1], 10), box: gb[2], slot: parseInt(gb[3], 10) };

  return null;
}

/** If SM1/SM2 → "SM1-<slot>", else "<grade><box><slot>" */
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

// Coarse HSV label (expects H in 0..180, S/V in 0..255)
function colorLabelFromHSV(h: number, s255: number, v255: number): string {
  if (isNaN(h) || isNaN(s255) || isNaN(v255)) return "unknown";
  if (s255 < 40 && v255 < 120) return "black";
  if (s255 < 40) return "gray";
  if (h < 10 || h > 170) return "red";
  if (h < 25) return "orange/brown";
  if (h < 35) return "yellow/gold";
  if (h < 85) return "green";
  if (h < 130) return "blue";
  return "purple";
}

// Otsu threshold (grayscale hist 0..255)
function otsuThreshold(grayHist: number[], total: number) {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * grayHist[i];

  let sumB = 0, wB = 0, maxVar = -1, threshold = 127;

  for (let t = 0; t < 256; t++) {
    wB += grayHist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;

    sumB += t * grayHist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;

    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > maxVar) { maxVar = between; threshold = t; }
  }
  return threshold;
}

// Profiles (persisted baselines)
function loadProfiles(): Record<string, DeviceProfile> {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return {};
    const arr: DeviceProfile[] = JSON.parse(raw);
    const map: Record<string, DeviceProfile> = {};
    for (const p of arr) map[p.securityNumber.toUpperCase()] = p;
    return map;
  } catch {
    return {};
  }
}
function saveProfiles(map: Record<string, DeviceProfile>) {
  const arr = Object.values(map).sort((a, b) => a.securityNumber.localeCompare(b.securityNumber));
  localStorage.setItem(LS_KEY, JSON.stringify(arr));
}

// ---------- Component ----------
export default function App() {
  const [roster, setRoster] = useState<RosterRow[]>([]);
  const [grade, setGrade] = useState<number>(9);
  const [box, setBox] = useState<string>("A");

  // Crop & detection controls
  const [cropTop, setCropTop] = useState(9);
  const [cropLeft, setCropLeft] = useState(19);
  const [cropRight, setCropRight] = useState(83);
  const [cropBottom, setCropBottom] = useState(92);
  // Presence decision: phone present if (darkRatio ≥ minDark) OR (avgSat ≥ minSat)
  const [darkRatioMin, setDarkRatioMin] = useState(0.40); // 0..1
  const [satMin, setSatMin] = useState(0.20);             // 0..1

  const [imageFile, setImageFile] = useState<File | null>(null);
  const [results, setResults] = useState<JoinedRow[] | null>(null);

  const imgRef = useRef<HTMLImageElement | null>(null);
  const scanCanvasRef = useRef<HTMLCanvasElement | null>(null);    // hidden for processing
  const overlayRef = useRef<HTMLCanvasElement | null>(null);       // visible overlay

  // Learned profiles (persist across scans); we ONLY learn from real pictures.
  const [profiles, setProfiles] = useState<Record<string, DeviceProfile>>({});

  // Load roster & any existing profiles
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/phone-check/roster.xlsx");
        if (!res.ok) throw new Error("roster.xlsx not found");
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
      } catch (e) {
        console.error("Failed to load roster:", e);
      }
      setProfiles(loadProfiles());
    })();
  }, []);

  // -------- Grid Overlay Drawer (visible) --------
  const drawOverlay = () => {
    const img = imgRef.current;
    const overlay = overlayRef.current;
    if (!img || !overlay) return;

    const w = img.clientWidth;
    const h = img.clientHeight;
    if (w === 0 || h === 0) return;

    overlay.width = w;
    overlay.height = h;
    const ctx = overlay.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);

    const L = Math.round((cropLeft / 100) * w);
    const R = Math.round((cropRight / 100) * w);
    const T = Math.round((cropTop / 100) * h);
    const B = Math.round((cropBottom / 100) * h);

    ctx.save();
    ctx.strokeStyle = "rgba(0, 200, 0, 0.95)";
    ctx.fillStyle = "rgba(0, 200, 0, 0.08)";
    ctx.lineWidth = 2;
    ctx.fillRect(L, T, R - L, B - T);
    ctx.strokeRect(L, T, R - L, B - T);

    const cellW = Math.floor((R - L) / COLS);
    const cellH = Math.floor((B - T) / ROWS);

    const ix0 = (c: number) => Math.round(L + c * cellW + 0.18 * cellW);
    const ix1 = (c: number) => Math.round(L + c * cellW + 0.82 * cellW);
    const iy0 = (r: number) => Math.round(T + r * cellH + 0.18 * cellH);
    const iy1 = (r: number) => Math.round(T + r * cellH + 0.86 * cellH);

    // outer grid lines
    ctx.beginPath();
    for (let r = 1; r < ROWS; r++) {
      const y = T + r * cellH;
      ctx.moveTo(L, y); ctx.lineTo(R, y);
    }
    for (let c = 1; c < COLS; c++) {
      const x = L + c * cellW;
      ctx.moveTo(x, T); ctx.lineTo(x, B);
    }
    ctx.stroke();

    // inner dashed boxes + slot labels
    ctx.setLineDash([6, 4]);
    ctx.font = "12px sans-serif";
    ctx.fillStyle = "rgba(0,0,0,0.9)";
    ctx.textBaseline = "top";
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const x0 = ix0(c), x1 = ix1(c), y0 = iy0(r), y1 = iy1(r);
        ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
        const slot = r * COLS + c + 1;
        ctx.fillText(String(slot), x0 + 2, y0 + 2);
      }
    }
    ctx.restore();
  };

  useEffect(() => {
    drawOverlay();
    const onResize = () => drawOverlay();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageFile, cropTop, cropLeft, cropRight, cropBottom]);

  // --------- Core scan with Otsu + Saturation (hidden canvas) ---------
  const runScan = async () => {
    const img = imgRef.current;
    const canvas = scanCanvasRef.current;
    if (!img || !canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const w = img.naturalWidth;
    const h = img.naturalHeight;
    canvas.width = w; canvas.height = h;
    ctx.drawImage(img, 0, 0, w, h);

    const L = Math.round((cropLeft / 100) * w);
    const RR = Math.round((cropRight / 100) * w);
    const T = Math.round((cropTop / 100) * h);
    const B = Math.round((cropBottom / 100) * h);

    const cellW = Math.floor((RR - L) / COLS);
    const cellH = Math.floor((B - T) / ROWS);

    const rosterIndex = new Map<string, RosterRow>(
      roster.map(r => [r.securityNumber.toUpperCase(), r])
    );

    const detections: DetectionRow[] = [];

    for (let rr = 0; rr < ROWS; rr++) {
      for (let cc = 0; cc < COLS; cc++) {
        const x0 = L + cc * cellW;
        const y0 = T + rr * cellH;

        const innerX0 = Math.round(x0 + 0.18 * cellW);
        const innerX1 = Math.round(x0 + 0.82 * cellW);
        const innerY0 = Math.round(y0 + 0.18 * cellH);
        const innerY1 = Math.round(y0 + 0.86 * cellH);
        const innerW = Math.max(4, innerX1 - innerX0);
        const innerH = Math.max(4, innerY1 - innerY0);

        const imageData = ctx.getImageData(innerX0, innerY0, innerW, innerH);
        const data = imageData.data;

        const hist = new Array(256).fill(0);
        let total = 0;
        let sumH = 0, sumS = 0, sumV = 0;

        for (let y = 0; y < innerH; y += 2) {
          for (let x = 0; x < innerW; x += 2) {
            const i = (y * innerW + x) * 4;
            const r = data[i], g = data[i + 1], b = data[i + 2];

            const gray = Math.max(0, Math.min(255, Math.round(0.299 * r + 0.587 * g + 0.114 * b)));
            hist[gray]++; total++;

            const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
            const diff = mx - mn;
            let hVal = 0;
            if (diff !== 0) {
              if (mx === r) hVal = (60 * ((g - b) / diff) + 360) % 360;
              else if (mx === g) hVal = 60 * ((b - r) / diff + 2);
              else hVal = 60 * ((r - g) / diff + 4);
            }
            const sVal = mx === 0 ? 0 : diff / mx; // 0..1
            const vVal = mx / 255;                 // 0..1

            sumH += hVal / 2;
            sumS += sVal;
            sumV += vVal;
          }
        }

        const Tgray = total > 0 ? otsuThreshold(hist, total) : 128;
        let darkCount = 0;
        for (let gval = 0; gval <= Tgray; gval++) darkCount += hist[gval];
        const darkRatio = total ? darkCount / total : 0;

        const count = total || 1;
        const avgH = sumH / count;    // 0..180
        const avgS = sumS / count;    // 0..1
        const avgV = sumV / count;    // 0..1

        const present = darkRatio >= darkRatioMin || avgS >= satMin;

        const slot = rr * COLS + cc + 1;
        const sec = buildSecurityNumber(grade, box, slot);

        const confidence = Math.max(
          0,
          Math.min(1,
            0.6 * (darkRatioMin ? darkRatio / darkRatioMin : darkRatio) +
            0.4 * (satMin ? avgS / satMin : avgS)
          )
        );

        detections.push({
          slot,
          securityNumber: sec,
          phonePresent: present,
          presenceScore: Number(darkRatio.toFixed(3)),
          satScore: Number(avgS.toFixed(3)),
          confidence: Number(confidence.toFixed(3)),
          color: colorLabelFromHSV(avgH, avgS * 255, avgV * 255), // <-- learned from THIS photo
        });
      }
    }

    // Join with roster & determine status (and use any prior baseline if present)
    const prior = profiles; // already loaded from LS
    const joined: JoinedRow[] = detections.map((d) => {
      const ro = rosterIndex.get(d.securityNumber);
      const expected = prior[d.securityNumber]?.color ?? null;

      let status: Status;
      if (!ro) status = "UNASSIGNED";
      else if (!d.phonePresent) status = "MISSING";
      else if (expected && d.color !== expected) status = "SUSPICIOUS";
      else status = "TURNED_IN";

      return { ...d, ...ro, expectedColor: expected, status };
    });

    // Auto-learn baseline ONLY from this real photo for students without a baseline:
    // If assigned AND present AND no existing expected color → save detected color as baseline.
    const updatedProfiles: Record<string, DeviceProfile> = { ...prior };
    for (const r of joined) {
      if (r.fullName && r.phonePresent && !updatedProfiles[r.securityNumber]) {
        updatedProfiles[r.securityNumber] = {
          securityNumber: r.securityNumber,
          color: r.color,
          lastUpdated: new Date().toISOString(),
        };
      }
    }
    if (Object.keys(updatedProfiles).length !== Object.keys(prior).length) {
      setProfiles(updatedProfiles);
      saveProfiles(updatedProfiles);
      // also reflect expectedColor in current table
      for (const r of joined) {
        if (!r.expectedColor && updatedProfiles[r.securityNumber]) {
          r.expectedColor = updatedProfiles[r.securityNumber].color;
          if (r.status === "TURNED_IN") {
            // stays TURNED_IN
          }
        }
      }
    }

    setResults(joined);
  };

  // Export / Import baselines (if you want to sync across devices)
  const exportProfiles = () => downloadJSON("device-profiles.json", Object.values(profiles));
  const importProfiles = async (file: File | null) => {
    if (!file) return;
    try {
      const text = await file.text();
      const arr: DeviceProfile[] = JSON.parse(text);
      const map: Record<string, DeviceProfile> = { ...profiles };
      for (const p of arr) {
        const key = (p.securityNumber || "").toUpperCase();
        if (!key) continue;
        map[key] = { securityNumber: key, color: p.color, lastUpdated: p.lastUpdated || new Date().toISOString() };
      }
      setProfiles(map);
      saveProfiles(map);
      // refresh expectedColor in current results
      if (results) {
        const next = results.map(r => {
          const expected = map[r.securityNumber]?.color ?? null;
          let status: Status = r.status;
          if (r.fullName && r.phonePresent && expected && r.color !== expected) status = "SUSPICIOUS";
          else if (r.fullName && r.phonePresent) status = "TURNED_IN";
          return { ...r, expectedColor: expected, status };
        });
        setResults(next);
      }
    } catch {
      alert("Invalid device-profiles.json");
    }
  };

  const counts = useMemo(() => ({
    unassigned: results?.filter(r => r.status === "UNASSIGNED").length ?? 0,
    missing: results?.filter(r => r.status === "MISSING").length ?? 0,
    suspicious: results?.filter(r => r.status === "SUSPICIOUS").length ?? 0,
    turnedIn: results?.filter(r => r.status === "TURNED_IN").length ?? 0,
  }), [results]);

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <h1 className="text-2xl font-bold">Phone Check – One Box (Grades 9–12, A–F + SM1/SM2)</h1>
      <p className="text-sm text-gray-600">
        Grades are limited to 9–12. Phone color is always learned from the current photo (no guessing).
      </p>

      {/* Profiles toolbar */}
      <div className="flex flex-wrap gap-2 items-center">
        <button className="px-3 py-1.5 rounded bg-gray-100 border" onClick={exportProfiles}>Export Profiles</button>
        <label className="px-3 py-1.5 rounded bg-gray-100 border cursor-pointer">
          Import Profiles
          <input type="file" accept="application/json" onChange={(e) => importProfiles(e.target.files?.[0] ?? null)} className="hidden" />
        </label>
        <span className="text-xs text-gray-500">Baselines persist locally; export to sync or back up.</span>
      </div>

      {/* Controls */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Left: Inputs */}
        <div className="space-y-3 p-4 rounded-2xl shadow bg-white">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-gray-600">Grade</label>
              <select
                value={box.startsWith("SM") ? "" : String(grade)}
                onChange={(e) => setGrade(parseInt(e.target.value || "9", 10))}
                disabled={box.startsWith("SM")}
                className="w-full border rounded px-2 py-1 disabled:bg-gray-100 disabled:text-gray-500"
              >
                {GRADES.map(g => <option key={g} value={g}>{g}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs text-gray-600">Box</label>
              <select value={box} onChange={(e) => setBox(e.target.value)} className="w-full border rounded px-2 py-1">
                {BOX_OPTIONS.map(b => <option key={b} value={b}>{b}</option>)}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium">Take Picture</label>
            <input
              type="file"
              accept="image/*"
              capture="environment"
              onChange={(e) => { setImageFile(e.target.files?.[0] ?? null); setResults(null); setTimeout(drawOverlay, 0); }}
              className="block w-full"
            />
          </div>

          {/* Crop & detection tuning */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 pt-2">
            <label className="block text-xs">Crop Top %
              <input type="number" value={cropTop} onChange={(e) => setCropTop(parseFloat(e.target.value || "9"))} className="w-full border rounded px-2 py-1" />
            </label>
            <label className="block text-xs">Crop Left %
              <input type="number" value={cropLeft} onChange={(e) => setCropLeft(parseFloat(e.target.value || "19"))} className="w-full border rounded px-2 py-1" />
            </label>
            <label className="block text-xs">Crop Right %
              <input type="number" value={cropRight} onChange={(e) => setCropRight(parseFloat(e.target.value || "83"))} className="w-full border rounded px-2 py-1" />
            </label>
            <label className="block text-xs">Crop Bottom %
              <input type="number" value={cropBottom} onChange={(e) => setCropBottom(parseFloat(e.target.value || "92"))} className="w-full border rounded px-2 py-1" />
            </label>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <label className="block text-xs">Min Dark Ratio (Otsu)
              <input
                type="number" step="0.01" min={0} max={1}
                value={darkRatioMin}
                onChange={(e) => setDarkRatioMin(Math.min(1, Math.max(0, parseFloat(e.target.value || "0.4"))))}
                className="w-full border rounded px-2 py-1"
              />
            </label>
            <label className="block text-xs">Min Avg Saturation
              <input
                type="number" step="0.01" min={0} max={1}
                value={satMin}
                onChange={(e) => setSatMin(Math.min(1, Math.max(0, parseFloat(e.target.value || "0.2"))))}
                className="w-full border rounded px-2 py-1"
              />
            </label>
          </div>

          <div className="flex gap-2 pt-2">
            <button
              className="px-4 py-2 rounded-xl bg-black text-white shadow"
              onClick={() => { runScan(); }}
              disabled={!imageFile || roster.length === 0}
            >
              Scan Box
            </button>
            {results && (
              <button
                className="px-4 py-2 rounded-xl bg-gray-100 border"
                onClick={() =>
                  downloadCSV(`${box.startsWith("SM") ? box : `${grade}${box}`}_scan.csv`, toCSV(results))
                }
              >
                Download CSV
              </button>
            )}
          </div>
        </div>

        {/* Right: Preview + Grid Overlay */}
        <div className="space-y-3 p-4 rounded-2xl shadow bg-white">
          <div className="text-sm font-medium">Preview & Grid</div>
          <div className="relative border rounded-xl overflow-hidden">
            {imageFile ? (
              <>
                <img
                  ref={imgRef}
                  src={URL.createObjectURL(imageFile)}
                  alt="box"
                  onLoad={() => drawOverlay()}
                  className="max-h-[480px] w-full object-contain block"
                />
                <canvas
                  ref={overlayRef}
                  className="absolute inset-0 w-full h-full pointer-events-none"
                  aria-hidden="true"
                />
              </>
            ) : (
              <div className="h-64 flex items-center justify-center text-gray-400">
                Take a photo to preview
              </div>
            )}
            <canvas ref={scanCanvasRef} className="hidden" />
          </div>
          <p className="text-xs text-gray-500">
            Green rectangle = crop. Solid lines = slots. Dashed boxes = pixels analyzed.
          </p>
        </div>
      </div>

      {/* Results */}
      {results && (
        <div className="p-4 rounded-2xl shadow bg-white">
          <div className="flex flex-wrap items-center gap-4 mb-3">
            <span className="text-sm">Summary:</span>
            <span className="text-xs px-2 py-1 rounded-full bg-green-100">Turned In: {counts.turnedIn}</span>
            <span className="text-xs px-2 py-1 rounded-full bg-amber-100">Suspicious: {counts.suspicious}</span>
            <span className="text-xs px-2 py-1 rounded-full bg-red-100">Missing: {counts.missing}</span>
            <span className="text-xs px-2 py-1 rounded-full bg-yellow-100">Unassigned: {counts.unassigned}</span>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left border-b">
                  <th className="py-2 pr-3">Slot</th>
                  <th className="py-2 pr-3">Security #</th>
                  <th className="py-2 pr-3">Full Name</th>
                  <th className="py-2 pr-3">Person ID</th>
                  <th className="py-2 pr-3">Grade</th>
                  <th className="py-2 pr-3">Present</th>
                  <th className="py-2 pr-3">Detected</th>
                  <th className="py-2 pr-3">Expected</th>
                  <th className="py-2 pr-3">Dark</th>
                  <th className="py-2 pr-3">Sat</th>
                  <th className="py-2 pr-3">Conf</th>
                  <th className="py-2 pr-3">Status</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r) => (
                  <tr key={r.slot} className="border-b last:border-0">
                    <td className="py-1 pr-3">{r.slot}</td>
                    <td className="py-1 pr-3">{r.securityNumber}</td>
                    <td className="py-1 pr-3">{r.fullName ?? "—"}</td>
                    <td className="py-1 pr-3">{r.personId ?? "—"}</td>
                    <td className="py-1 pr-3">{r.currentGrade ?? "—"}</td>
                    <td className="py-1 pr-3">{r.phonePresent ? "Yes" : "No"}</td>
                    <td className="py-1 pr-3">{r.color}</td>
                    <td className="py-1 pr-3">{r.expectedColor ?? "—"}</td>
                    <td className="py-1 pr-3">{r.presenceScore.toFixed(3)}</td>
                    <td className="py-1 pr-3">{r.satScore.toFixed(3)}</td>
                    <td className="py-1 pr-3">{r.confidence.toFixed(3)}</td>
                    <td className="py-1 pr-3">
                      {r.status === "TURNED_IN" && <span className="text-green-700">✅ Turned In</span>}
                      {r.status === "SUSPICIOUS" && <span className="text-amber-700">⚠️ Suspicious</span>}
                      {r.status === "MISSING" && <span className="text-red-700">❌ Missing</span>}
                      {r.status === "UNASSIGNED" && <span className="text-gray-500">— Unassigned</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-gray-500">
            Baselines are created only from real photos where a student’s phone is detected as present.
            On later scans, a different detected color for that student will be flagged as Suspicious.
          </p>
        </div>
      )}
    </div>
  );
}
