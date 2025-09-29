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
  color: string;
}
interface JoinedRow extends DetectionRow {
  personId?: string;
  fullName?: string;
  currentGrade?: string;
  status: "TURNED_IN" | "MISSING" | "UNASSIGNED";
}

// ---------- Helpers ----------
function parseSecurityNumber(sn: string) {
  const m = sn?.toString().trim().toUpperCase().match(/^(\d{1,2})([A-Z])(\d{1,2})$/);
  if (!m) return null;
  return { grade: parseInt(m[1], 10), box: m[2], slot: parseInt(m[3], 10) };
}
function buildSecurityNumber(grade: number, box: string, slot: number) {
  return `${grade}${box}${slot}`;
}
function toCSV(rows: JoinedRow[]) {
  const header = [
    "Slot","Security Number","Full Name","Person ID","Current Grade",
    "Phone Present","Presence Score","Dominant Color","Status",
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
      r.status,
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
function colorLabelFromHSV(h: number, s: number, v: number): string {
  if (isNaN(h) || isNaN(s) || isNaN(v)) return "unknown";
  if (s < 40 && v < 120) return "black";
  if (s < 40) return "gray";
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
  const [boxes, setBoxes] = useState<{ grade: number; box: string }[]>([]);
  const [grade, setGrade] = useState<number>(9);
  const [box, setBox] = useState<string>("A");

  const [imageFile, setImageFile] = useState<File | null>(null);
  const [results, setResults] = useState<JoinedRow[] | null>(null);

  // Grid controls
  const rows = 5, cols = 12;
  const [cropTop, setCropTop] = useState(9);
  const [cropLeft, setCropLeft] = useState(19);
  const [cropRight, setCropRight] = useState(83);
  const [cropBottom, setCropBottom] = useState(92);
  const [presenceThreshold, setPresenceThreshold] = useState(0.35);

  const imgRef = useRef<HTMLImageElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Auto-load roster from /roster.xlsx
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/phone-check/roster.xlsx");
        if (!res.ok) throw new Error("No roster.xlsx found");
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
        // Collect Grade/Box pairs
        const seen = new Set<string>();
        const pairs: { grade: number; box: string }[] = [];
        for (const row of normalized) {
          const parsed = parseSecurityNumber(row.securityNumber);
          if (parsed) {
            const key = `${parsed.grade}${parsed.box}`;
            if (!seen.has(key)) {
              seen.add(key);
              pairs.push({ grade: parsed.grade, box: parsed.box });
            }
          }
        }
        pairs.sort((a, b) => a.grade - b.grade || a.box.localeCompare(b.box));
        setBoxes(pairs);
      } catch (err) {
        console.error("Roster load failed:", err);
      }
    })();
  }, []);

  // Scan logic
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

    const cellW = Math.floor((R - L) / cols);
    const cellH = Math.floor((B - T) / rows);

    const detections: DetectionRow[] = [];
    for (let rr = 0; rr < rows; rr++) {
      for (let cc = 0; cc < cols; cc++) {
        const x0 = L + cc * cellW;
        const y0 = T + rr * cellH;
        const innerX0 = Math.round(x0 + 0.2 * cellW);
        const innerX1 = Math.round(x0 + 0.8 * cellW);
        const innerY0 = Math.round(y0 + 0.15 * cellH);
        const innerY1 = Math.round(y0 + 0.85 * cellH);
        const innerW = innerX1 - innerX0;
        const innerH = innerY1 - innerY0;
        const data = ctx.getImageData(innerX0, innerY0, innerW, innerH).data;

        let darkCount = 0, count = 0;
        let sumH = 0, sumS = 0, sumV = 0;
        for (let i = 0; i < data.length; i += 4) {
          const r = data[i], g = data[i + 1], b = data[i + 2];
          const gray = 0.299 * r + 0.587 * g + 0.114 * b;
          if (gray < 180) darkCount++;
          const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
          const diff = mx - mn;
          let hVal = 0;
          if (diff !== 0) {
            if (mx === r) hVal = (60 * ((g - b) / diff) + 360) % 360;
            else if (mx === g) hVal = 60 * ((b - r) / diff + 2);
            else hVal = 60 * ((r - g) / diff + 4);
          }
          const sVal = mx === 0 ? 0 : (diff / mx) * 255;
          const vVal = mx;
          sumH += hVal / 2; sumS += sVal; sumV += vVal;
          count++;
        }
        const darkRatio = count ? darkCount / count : 0;
        const avgH = sumH / count, avgS = sumS / count, avgV = sumV / count;
        const present = darkRatio > presenceThreshold;
        detections.push({
          slot: rr * cols + cc + 1,
          securityNumber: buildSecurityNumber(grade, box, rr * cols + cc + 1),
          phonePresent: present,
          presenceScore: Number(darkRatio.toFixed(3)),
          color: colorLabelFromHSV(avgH, avgS, avgV),
        });
      }
    }

    const rosterIndex = new Map(roster.map((r) => [r.securityNumber.toUpperCase(), r]));
    const joined: JoinedRow[] = detections.map((d) => {
      const ro = rosterIndex.get(d.securityNumber);
      const status: JoinedRow["status"] = !ro
        ? "UNASSIGNED"
        : d.phonePresent ? "TURNED_IN" : "MISSING";
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
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <h1 className="text-2xl font-bold">Phone Check – One Box</h1>
      <p className="text-sm text-gray-600">
        Pick a box from the roster, take a picture of the box, then scan.
      </p>

      {/* Select box + photo */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs">Select Box</label>
          <select
            value={`${grade}${box}`}
            onChange={(e) => {
              const g = parseInt(e.target.value.slice(0, -1), 10);
              const b = e.target.value.slice(-1);
              setGrade(g); setBox(b);
            }}
            className="w-full border rounded px-2 py-1"
          >
            {boxes.map((p) => (
              <option key={`${p.grade}${p.box}`} value={`${p.grade}${p.box}`}>
                Grade {p.grade} – Box {p.box}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs">Take Picture</label>
          <input
            type="file"
            accept="image/*"
            capture="environment"
            onChange={(e) => setImageFile(e.target.files?.[0] ?? null)}
            className="w-full"
          />
        </div>
      </div>

      <div>
        <button
          className="px-4 py-2 rounded bg-black text-white"
          onClick={runScan}
          disabled={!imageFile || roster.length === 0}
        >
          Scan Box
        </button>
        {results && (
          <button
            className="ml-3 px-4 py-2 rounded bg-gray-100 border"
            onClick={() => download(`${grade}${box}_scan.csv`, toCSV(results))}
          >
            Download CSV
          </button>
        )}
      </div>

      {/* Preview */}
      <div className="border rounded-xl overflow-hidden">
        {imageFile ? (
          <img
            ref={imgRef}
            src={URL.createObjectURL(imageFile)}
            alt="box"
            className="max-h-[480px] w-full object-contain"
          />
        ) : (
          <div className="h-64 flex items-center justify-center text-gray-400">
            Take a photo to preview
          </div>
        )}
        <canvas ref={canvasRef} className="hidden" />
      </div>

      {/* Results */}
      {results && (
        <div className="p-4 rounded-2xl shadow bg-white">
          <div className="mb-3 flex gap-3">
            <span>✅ Turned In: {counts.turnedIn}</span>
            <span>❌ Missing: {counts.missing}</span>
            <span>— Unassigned: {counts.unassigned}</span>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th>Slot</th><th>Sec #</th><th>Name</th><th>ID</th>
                  <th>Grade</th><th>Present</th><th>Color</th><th>Score</th><th>Status</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r) => (
                  <tr key={r.slot} className="border-b last:border-0">
                    <td>{r.slot}</td>
                    <td>{r.securityNumber}</td>
                    <td>{r.fullName ?? "—"}</td>
                    <td>{r.personId ?? "—"}</td>
                    <td>{r.currentGrade ?? "—"}</td>
                    <td>{r.phonePresent ? "Yes" : "No"}</td>
                    <td>{r.color}</td>
                    <td>{r.presenceScore.toFixed(3)}</td>
                    <td>{r.status}</td>
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
