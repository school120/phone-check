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
  color: string;         // coarse color label
}
type Status = "TURNED_IN" | "MISSING" | "UNASSIGNED";
interface JoinedRow extends DetectionRow {
  personId?: string;
  fullName?: string;
  currentGrade?: string;
  status: Status;
}

// ---------- Constants ----------
const BOX_OPTIONS = ["A", "B", "C", "D", "E", "F", "SM1", "SM2"] as const;
const ROWS = 5;
const COLS = 12;

// ---------- Helpers ----------
/** Accepts:
 *  • Grade + box A–F:  "9A23", "10F12"
 *  • Standalone SM:    "SM1-23", "SM2-9" (hyphen optional; spaces ignored)
 */
function parseSecurityNumber(sn: string) {
  const s = sn?.toString().trim().toUpperCase().replace(/\s+/g, "");
  if (!s) return null;

  // SM1/SM2 standalone (no grade)
  const sm = s.match(/^(SM1|SM2)-?(\d{1,3})$/);
  if (sm) {
    return { grade: null as unknown as number, box: sm[1], slot: parseInt(sm[2], 10) };
  }

  // Grade + box A–F
  const gb = s.match(/^(\d{1,2})([ABCDEF])(\d{1,3})$/);
  if (gb) {
    return { grade: parseInt(gb[1], 10), box: gb[2], slot: parseInt(gb[3], 10) };
  }

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
    "Present","Presence Score","Saturation","Confidence","Color","Status",
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
      r.status,
    ].join(","));
  }
  return lines.join("\n");
}

function downloadCSV(filename: string, text: string) {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// Coarse HSV label (expects H in 0..180, S/V in 0..255)
function colorLabelFromHSV(avgH: number, avgS255: number, avgV255: number): string {
  if (isNaN(avgH) || isNaN(avgS255) || isNaN(avgV255)) return "unknown";
  if (avgS255 < 40 && avgV255 < 120) return "black";
  if (avgS255 < 40) return "gray";
  if (avgH < 10 || avgH > 170) return "red";
  if (avgH < 25) return "orange/brown";
  if (avgH < 35) return "yellow/gold";
  if (avgH < 85) return "green";
  if (avgH < 130) return "blue";
  return "purple";
}

// Otsu threshold (grayscale hist 0..255)
function otsuThreshold(grayHist: number[], total: number) {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * grayHist[i];

  let sumB = 0;
  let wB = 0;
  let maxVar = -1;
  let threshold = 127;

  for (let t = 0; t < 256; t++) {
    wB += grayHist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;

    sumB += t * grayHist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;

    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > maxVar) {
      maxVar = between;
      threshold = t;
    }
  }
  return threshold;
}

// ---------- Component ----------
export default function App() {
  const [roster, setRoster] = useState<RosterRow[]>([]);
  const [grade, setGrade] = useState<number>(9);
  const [box, setBox] = useState<string>("A");

  // Crop & detection controls (defaults tuned for your sample photo)
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
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Load roster.xlsx from /public
  useEffect(() => {
    (async () => {
      try {
        // NOTE: on GitHub Pages under repo "phone-check", the file path is /phone-check/roster.xlsx
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
    })();
  }, []);

  // Core scan with Otsu + Saturation
  const runScan = async () => {
    const img = imgRef.current;
    const canvas = canvasRef.current;
    if (!img || !canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const w = img.naturalWidth;
    const h = img.naturalHeight;
    canvas.width = w; canvas.height = h;
    ctx.drawImage(img, 0, 0, w, h);

    const L = Math.round((cropLeft / 100) * w);
    const R = Math.round((cropRight / 100) * w);
    const T = Math.round((cropTop / 100) * h);
    const B = Math.round((cropBottom / 100) * h);

    const cellW = Math.floor((R - L) / COLS);
    const cellH = Math.floor((B - T) / ROWS);

    // Build roster index for quick join
    const rosterIndex = new Map<string, RosterRow>(
      roster.map(r => [r.securityNumber.toUpperCase(), r])
    );

    const detections: DetectionRow[] = [];

    for (let rr = 0; rr < ROWS; rr++) {
      for (let cc = 0; cc < COLS; cc++) {
        const x0 = L + cc * cellW;
        const y0 = T + rr * cellH;

        // Inner crop to avoid dividers/labels
        const innerX0 = Math.round(x0 + 0.18 * cellW);
        const innerX1 = Math.round(x0 + 0.82 * cellW);
        const innerY0 = Math.round(y0 + 0.18 * cellH);
        const innerY1 = Math.round(y0 + 0.86 * cellH);
        const innerW = Math.max(4, innerX1 - innerX0);
        const innerH = Math.max(4, innerY1 - innerY0);

        const imageData = ctx.getImageData(innerX0, innerY0, innerW, innerH);
        const data = imageData.data;

        // Histogram + HSV averages (sample every 2nd pixel)
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

            sumH += hVal / 2;   // 0..180
            sumS += sVal;       // 0..1
            sumV += vVal;       // 0..1
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
          color: colorLabelFromHSV(avgH, avgS * 255, avgV * 255),
        });
      }
    }

    // Join with roster & set status
    const joined: JoinedRow[] = detections.map((d) => {
      const ro = rosterIndex.get(d.securityNumber);
      let status: Status;
      if (!ro) status = "UNASSIGNED";
      else if (!d.phonePresent) status = "MISSING";
      else status = "TURNED_IN";
      return { ...d, ...ro, status };
    });

    setResults(joined);
  };

  const counts = useMemo(() => ({
    unassigned: results?.filter(r => r.status === "UNASSIGNED").length ?? 0,
    missing: results?.filter(r => r.status === "MISSING").length ?? 0,
    turnedIn: results?.filter(r => r.status === "TURNED_IN").length ?? 0,
  }), [results]);

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <h1 className="text-2xl font-bold">Phone Check – One Box (A–F + SM1/SM2)</h1>
      <p className="text-sm text-gray-600">
        Select Grade + Box (A–F) or SM box (SM1/SM2), take a photo, then Scan. Detection uses Otsu (darkness) + saturation for robustness.
      </p>

      {/* Controls */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Left: Inputs */}
        <div className="space-y-3 p-4 rounded-2xl shadow bg-white">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-gray-600">Grade</label>
              <input
                type="number"
                value={box.startsWith("SM") ? 0 : grade}
                onChange={(e) => setGrade(parseInt(e.target.value || "9", 10))}
                disabled={box.startsWith("SM")}
                className="w-full border rounded px-2 py-1 disabled:bg-gray-100 disabled:text-gray-500"
              />
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
              onChange={(e) => setImageFile(e.target.files?.[0] ?? null)}
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
              onClick={runScan}
              disabled={!imageFile || roster.length === 0}
            >
              Scan Box
            </button>
            {results && (
              <button
                className="px-4 py-2 rounded-xl bg-gray-100 border"
                onClick={() => downloadCSV(`${box.startsWith("SM") ? box : `${grade}${box}`}_scan.csv`, toCSV(results))}
              >
                Download CSV
              </button>
            )}
          </div>
        </div>

        {/* Right: Preview */}
        <div className="space-y-3 p-4 rounded-2xl shadow bg-white">
          <div className="text-sm font-medium">Preview</div>
          <div className="relative border rounded-xl overflow-hidden">
            {imageFile ? (
              <img
                ref={imgRef}
                src={URL.createObjectURL(imageFile)}
                alt="box"
                className="max-h-[480px] w-full object-contain"
              />
            ) : (
              <div className="h-64 flex items-center justify-center text-gray-400">Take a photo to preview</div>
            )}
            <canvas ref={canvasRef} className="hidden" />
          </div>
          <p className="text-xs text-gray-500">
            Adjust crop so each cell’s inner area sits on the slot foam. Then tweak Min Dark Ratio / Min Saturation if needed.
          </p>
        </div>
      </div>

      {/* Results */}
      {results && (
        <div className="p-4 rounded-2xl shadow bg-white">
          <div className="flex flex-wrap items-center gap-4 mb-3">
            <span className="text-sm">Summary:</span>
            <span className="text-xs px-2 py-1 rounded-full bg-green-100">Turned In: {counts.turnedIn}</span>
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
                  <th className="py-2 pr-3">Color</th>
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
                    <td className="py-1 pr-3">{r.presenceScore.toFixed(3)}</td>
                    <td className="py-1 pr-3">{r.satScore.toFixed(3)}</td>
                    <td className="py-1 pr-3">{r.confidence.toFixed(3)}</td>
                    <td className="py-1 pr-3">
                      {r.status === "TURNED_IN" && <span className="text-green-700">✅ Turned In</span>}
                      {r.status === "MISSING" && <span className="text-red-700">❌ Missing</span>}
                      {r.status === "UNASSIGNED" && <span className="text-gray-500">— Unassigned</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
