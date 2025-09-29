import React, { useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";

// One-file React web app (client-only) that:
// 1) Lets you upload a box photo and a roster Excel (Person ID, Full Name, Security Number, Current Grade)
// 2) Choose Grade + Box (e.g., 9 and A)
// 3) Splits the image into a 5x12 grid, computes presence and rough dominant color per slot
// 4) Joins results with the roster by Security Number (e.g., 9A1..9A60)
// 5) Displays a results table and lets you download CSV

interface RosterRow {
  personId: string;
  fullName: string;
  securityNumber: string; // e.g., 9A23
  currentGrade?: string;
}

interface DetectionRow {
  slot: number;
  securityNumber: string;
  phonePresent: boolean;
  presenceScore: number;
  color: string;
}

interface JoinedRow extends DetectionRow {
  personId?: string;
  fullName?: string;
  currentGrade?: string;
  status: "TURNED_IN" | "MISSING" | "UNASSIGNED";
}

function buildSecurityNumber(grade: number, box: string, slot: number) {
  return `${grade}${box}${slot}`;
}

function toCSV(rows: JoinedRow[]) {
  const header = [
    "Slot",
    "Security Number",
    "Full Name",
    "Person ID",
    "Current Grade",
    "Phone Present",
    "Presence Score",
    "Dominant Color",
    "Status",
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
      r.color,
      r.status === "TURNED_IN" ? "Turned In" : r.status === "MISSING" ? "Missing" : "Unassigned",
    ].join(","));
  }
  return lines.join("\n");
}

function download(filename: string, text: string) {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// Compute dominant color label using naive HSV buckets
function colorLabelFromHSV(avgH: number, avgS: number, avgV: number): string {
  if (isNaN(avgH) || isNaN(avgS) || isNaN(avgV)) return "unknown";
  if (avgS < 40 && avgV < 120) return "black";
  if (avgS < 40) return "gray";
  if (avgH < 10 || avgH > 170) return "red";
  if (avgH < 25) return "orange/brown";
  if (avgH < 35) return "yellow/gold";
  if (avgH < 85) return "green";
  if (avgH < 130) return "blue";
  return "purple";
}

export default function App() {
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [grade, setGrade] = useState<number>(9);
  const [box, setBox] = useState<string>("A");

  // Grid & crop controls — tuned for your example photo
  const [rows, setRows] = useState<number>(5);
  const [cols, setCols] = useState<number>(12);
  const [cropTop, setCropTop] = useState<number>(9);   // %
  const [cropLeft, setCropLeft] = useState<number>(19);
  const [cropRight, setCropRight] = useState<number>(83);
  const [cropBottom, setCropBottom] = useState<number>(92);
  const [presenceThreshold, setPresenceThreshold] = useState<number>(0.35);

  const [roster, setRoster] = useState<RosterRow[]>([]);
  const [results, setResults] = useState<JoinedRow[] | null>(null);

  const imgRef = useRef<HTMLImageElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Load roster when a file is selected
  const onRosterChange = async (f: File | null) => {
    if (!f) { setRoster([]); return; }
    const data = await f.arrayBuffer();
    const wb = XLSX.read(data);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const json: any[] = XLSX.utils.sheet_to_json(ws, { defval: "" });
    const normalized: RosterRow[] = json.map((r) => ({
      personId: String(r["Person ID"] ?? ""),
      fullName: String(r["Full Name"] ?? ""),
      securityNumber: String(r["Security Number"] ?? "").toUpperCase().trim(),
      currentGrade: String(r["Current Grade"] ?? ""),
    }));
    setRoster(normalized);
  };

  // Draw preview with overlay grid
  const drawPreview = () => {
    const img = imgRef.current;
    const canvas = canvasRef.current;
    if (!img || !canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const w = img.naturalWidth;
    const h = img.naturalHeight;
    canvas.width = w;
    canvas.height = h;

    ctx.drawImage(img, 0, 0, w, h);

    const L = Math.round((cropLeft / 100) * w);
    const R = Math.round((cropRight / 100) * w);
    const T = Math.round((cropTop / 100) * h);
    const B = Math.round((cropBottom / 100) * h);

    // Overlay green grid
    ctx.save();
    ctx.strokeStyle = "#00ff00";
    ctx.lineWidth = 2;
    ctx.strokeRect(L, T, R - L, B - T);
    const cellW = Math.floor((R - L) / cols);
    const cellH = Math.floor((B - T) / rows);
    for (let r = 1; r < rows; r++) {
      const y = T + r * cellH;
      ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(R, y); ctx.stroke();
    }
    for (let c = 1; c < cols; c++) {
      const x = L + c * cellW;
      ctx.beginPath(); ctx.moveTo(x, T); ctx.lineTo(x, B); ctx.stroke();
    }
    ctx.restore();
  };

  const onImageLoaded = () => drawPreview();

  // Core scan
  const runScan = async () => {
    const img = imgRef.current;
    const canvas = canvasRef.current;
    if (!img || !canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Ensure preview drawn
    drawPreview();

    const w = img.naturalWidth;
    const h = img.naturalHeight;
    const L = Math.round((cropLeft / 100) * w);
    const R = Math.round((cropRight / 100) * w);
    const T = Math.round((cropTop / 100) * h);
    const B = Math.round((cropBottom / 100) * h);

    const gridW = R - L;
    const gridH = B - T;
    const cellW = Math.floor(gridW / cols);
    const cellH = Math.floor(gridH / rows);

    const detections: DetectionRow[] = [];

    for (let rr = 0; rr < rows; rr++) {
      for (let cc = 0; cc < cols; cc++) {
        const x0 = L + cc * cellW;
        const y0 = T + rr * cellH;

        // Inner crop to avoid dividers
        const innerX0 = Math.round(x0 + 0.20 * cellW);
        const innerX1 = Math.round(x0 + 0.80 * cellW);
        const innerY0 = Math.round(y0 + 0.15 * cellH);
        const innerY1 = Math.round(y0 + 0.85 * cellH);

        const innerW = innerX1 - innerX0;
        const innerH = innerY1 - innerY0;
        const imageData = ctx.getImageData(innerX0, innerY0, innerW, innerH);
        const data = imageData.data; // RGBA

        let darkCount = 0, count = 0;
        let sumH = 0, sumS = 0, sumV = 0;

        for (let i = 0; i < data.length; i += 4) {
          const r = data[i], g = data[i + 1], b = data[i + 2];
          const gray = 0.299 * r + 0.587 * g + 0.114 * b;
          if (gray < 180) darkCount++;

          const mx = Math.max(r, g, b);
          const mn = Math.min(r, g, b);
          const diff = mx - mn;
          let hVal = 0;
          if (diff !== 0) {
            if (mx === r) hVal = (60 * ((g - b) / diff) + 360) % 360;
            else if (mx === g) hVal = 60 * ((b - r) / diff + 2);
            else hVal = 60 * ((r - g) / diff + 4);
          }
          const sVal = mx === 0 ? 0 : (diff / mx) * 255;
          const vVal = mx;

          sumH += (hVal / 2); // 0..180 like OpenCV
          sumS += sVal;
          sumV += vVal;
          count++;
        }

        const darkRatio = count > 0 ? darkCount / count : 0;
        const avgH = count > 0 ? sumH / count : NaN;
        const avgS = count > 0 ? sumS / count : NaN;
        const avgV = count > 0 ? sumV / count : NaN;

        const present = darkRatio > presenceThreshold;
        const color = colorLabelFromHSV(avgH, avgS, avgV);
        const slot = rr * cols + cc + 1;

        detections.push({
          slot,
          securityNumber: buildSecurityNumber(grade, box, slot),
          phonePresent: present,
          presenceScore: Number(darkRatio.toFixed(3)),
          color,
        });
      }
    }

    // Join with roster
    const rosterIndex = new Map<string, RosterRow>();
    for (const r of roster) {
      if (!r.securityNumber) continue;
      rosterIndex.set(r.securityNumber.toUpperCase(), r);
    }

    const joined: JoinedRow[] = detections.map((d) => {
      const ro = rosterIndex.get(d.securityNumber);
      const assigned = !!ro;
      const status: JoinedRow["status"] = !assigned
        ? "UNASSIGNED"
        : d.phonePresent
        ? "TURNED_IN"
        : "MISSING";
      return {
        ...d,
        personId: ro?.personId,
        fullName: ro?.fullName,
        currentGrade: ro?.currentGrade,
        status,
      };
    });

    setResults(joined);
  };

  const unassignedCount = useMemo(
    () => (results ? results.filter((r) => r.status === "UNASSIGNED").length : 0),
    [results]
  );
  const missingCount = useMemo(
    () => (results ? results.filter((r) => r.status === "MISSING").length : 0),
    [results]
  );
  const turnedInCount = useMemo(
    () => (results ? results.filter((r) => r.status === "TURNED_IN").length : 0),
    [results]
  );

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <h1 className="text-2xl font-bold">Phone Check – One Box Scanner (MVP)</h1>
      <p className="text-sm text-gray-600">
        Upload a box photo and your roster Excel. Adjust crop if needed, then Scan. The app will compute presence/color per slot and join with your roster for this grade/box.
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Controls */}
        <div className="space-y-3 p-4 rounded-2xl shadow bg-white">
          <label className="block text-sm font-medium">Box Photo</label>
          <input
            type="file"
            accept="image/*"
            capture="environment"
            onChange={(e) => setImageFile(e.target.files?.[0] ?? null)}
            className="block w-full"
          />

          <label className="block text-sm font-medium">Roster Excel (.xlsx)</label>
          <input
            type="file"
            accept=".xlsx,.xls"
            onChange={(e) => onRosterChange(e.target.files?.[0] ?? null)}
            className="block w-full"
          />

          <div className="grid grid-cols-3 gap-3 pt-2">
            <div>
              <label className="block text-xs text-gray-600">Grade</label>
              <input type="number" value={grade} onChange={(e) => setGrade(parseInt(e.target.value || "9", 10))} className="w-full border rounded px-2 py-1" />
            </div>
            <div>
              <label className="block text-xs text-gray-600">Box</label>
              <select value={box} onChange={(e) => setBox(e.target.value)} className="w-full border rounded px-2 py-1">
                <option value="A">A</option>
                <option value="B">B</option>
                <option value="C">C</option>
                <option value="D">D</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-gray-600">Grid (rows x cols)</label>
              <div className="flex gap-2">
                <input type="number" value={rows} onChange={(e) => setRows(parseInt(e.target.value || "5", 10))} className="w-1/2 border rounded px-2 py-1" />
                <input type="number" value={cols} onChange={(e) => setCols(parseInt(e.target.value || "12", 10))} className="w-1/2 border rounded px-2 py-1" />
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 pt-2">
            <div>
              <label className="block text-xs text-gray-600">Crop Top %</label>
              <input type="number" value={cropTop} onChange={(e) => setCropTop(parseFloat(e.target.value || "9"))} className="w-full border rounded px-2 py-1" />
            </div>
            <div>
              <label className="block text-xs text-gray-600">Crop Left %</label>
              <input type="number" value={cropLeft} onChange={(e) => setCropLeft(parseFloat(e.target.value || "19"))} className="w-full border rounded px-2 py-1" />
            </div>
            <div>
              <label className="block text-xs text-gray-600">Crop Right %</label>
              <input type="number" value={cropRight} onChange={(e) => setCropRight(parseFloat(e.target.value || "83"))} className="w-full border rounded px-2 py-1" />
            </div>
            <div>
              <label className="block text-xs text-gray-600">Crop Bottom %</label>
              <input type="number" value={cropBottom} onChange={(e) => setCropBottom(parseFloat(e.target.value || "92"))} className="w-full border rounded px-2 py-1" />
            </div>
          </div>

          <div className="pt-2">
            <label className="block text-xs text-gray-600">Presence Threshold</label>
            <input type="number" step="0.01" value={presenceThreshold} onChange={(e) => setPresenceThreshold(parseFloat(e.target.value || "0.35"))} className="w-full border rounded px-2 py-1" />
          </div>

          <div className="flex gap-2 pt-3">
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
                onClick={() => download(`${grade}${box}_scan.csv`, toCSV(results))}
              >
                Download CSV
              </button>
            )}
          </div>
        </div>

        {/* Preview Panel */}
        <div className="space-y-3 p-4 rounded-2xl shadow bg-white">
          <div className="text-sm font-medium">Preview & Overlay</div>
          <div className="relative border rounded-xl overflow-hidden">
            {imageFile ? (
              <img
                ref={imgRef}
                src={URL.createObjectURL(imageFile)}
                alt="box"
                onLoad={onImageLoaded}
                className="max-h-[480px] w-full object-contain"
              />
            ) : (
              <div className="h-64 flex items-center justify-center text-gray-400">Upload a photo to preview</div>
            )}
            <canvas ref={canvasRef} className="hidden" />
          </div>
          <p className="text-xs text-gray-500">Green lines show the scan area and slot grid. Adjust crop % if the overlay doesn’t align perfectly with your photo.</p>
        </div>
      </div>

      {/* Results */}
      {results && (
        <div className="p-4 rounded-2xl shadow bg-white">
          <div className="flex flex-wrap items-center gap-4 mb-3">
            <span className="text-sm">Summary:</span>
            <span className="text-xs px-2 py-1 rounded-full bg-green-100">Turned In: {turnedInCount}</span>
            <span className="text-xs px-2 py-1 rounded-full bg-yellow-100">Unassigned: {unassignedCount}</span>
            <span className="text-xs px-2 py-1 rounded-full bg-red-100">Missing: {missingCount}</span>
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
                  <th className="py-2 pr-3">Score</th>
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
