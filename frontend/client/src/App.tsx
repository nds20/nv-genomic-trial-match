import { useState, useRef, useEffect, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type CaseRow, type CaseDetail as Detail, type PlatformUser, type Role } from "./api";

type ThemeMode = "system" | "light" | "clinical-dark";

const CANCER_TYPES = [
  "Non-Small Cell Lung Cancer",
  "Breast Cancer",
  "Colorectal Cancer",
  "Pancreatic Cancer",
  "Melanoma",
  "Prostate Cancer",
  "Ovarian Cancer",
  "Gastric Cancer",
  "Bladder / Urothelial Cancer",
  "Endometrial Cancer",
  "Hepatocellular Carcinoma",
  "Renal Cell Carcinoma",
  "Thyroid Cancer",
  "Glioma / Glioblastoma",
  "Head and Neck Cancer",
  "Sarcoma",
  "Other / Rare Tumor",
];
const CANCER_GROUPS: Record<string, string[]> = {
  "Thoracic & Skin": ["Non-Small Cell Lung Cancer", "Melanoma", "Head and Neck Cancer"],
  "GI / Hepatobiliary": ["Colorectal Cancer", "Pancreatic Cancer", "Gastric Cancer", "Hepatocellular Carcinoma"],
  "GU / Gyn": ["Breast Cancer", "Prostate Cancer", "Ovarian Cancer", "Bladder / Urothelial Cancer", "Endometrial Cancer", "Renal Cell Carcinoma"],
  "Neuro / Endocrine / Sarcoma": ["Glioma / Glioblastoma", "Thyroid Cancer", "Sarcoma", "Other / Rare Tumor"],
};
const STAGES = ["Stage I", "Stage II", "Stage III", "Stage IV", "Recurrent", "Metastatic"];
const SAMPLE_TYPES = ["Tissue NGS", "Liquid Biopsy (ctDNA)", "Tissue + Liquid", "Whole Exome", "Targeted Panel (324 genes)", "Whole Genome", "RNA Sequencing"];

const SAMPLE_BIOMARKERS = ["EGFR", "ALK", "BRCA1", "KRAS", "BRAF"];
function confidenceColor(c: number) {
  if (c >= 90) return "bg-teal-600";
  if (c >= 82) return "bg-teal-500";
  if (c >= 75) return "bg-amber-500";
  return "bg-zinc-400";
}
function classBadge(cls: string) {
  if (cls === "Pathogenic") return "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-200 border border-rose-200 dark:border-rose-800";
  if (cls === "Predictive") return "bg-teal-100 text-teal-800 dark:bg-teal-900/40 dark:text-teal-200 border border-teal-200 dark:border-teal-800";
  return "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200 border border-amber-200";
}
function plainExplanation(gene: string, therapy: string): string {
  const map: Record<string, string> = {
    EGFR: "A growth signal in the cancer that can often be blocked with a targeted pill.",
    KRAS: "A long-known cancer driver that now has targeted drugs for some variants.",
    ALK: "A fused growth gene that usually responds very well to targeted pills.",
    BRCA1: "A DNA-repair weakness that makes the cancer sensitive to PARP drugs.",
    BRCA2: "A DNA-repair weakness that makes the cancer sensitive to PARP drugs and platinum chemo.",
    BRAF: "A growth-pathway change that can be blocked with combined targeted therapy.",
    HER2: "Extra copies of a growth receptor — HER2-targeted infusions/antibody-drugs can help.",
    "ERBB2 (HER2)": "Extra copies of a growth receptor — HER2-targeted therapy can help.",
    "PD-L1": "A marker suggesting immunotherapy (immune checkpoint treatment) may help.",
    "MSI / MMR": "A DNA-repair pattern that often responds exceptionally well to immunotherapy.",
    MMR: "A DNA-repair pattern that often responds exceptionally well to immunotherapy.",
    FGFR3: "A growth receptor change with an approved targeted pill in bladder cancer.",
    IDH1: "A metabolic gene change in brain tumors with a targeted pill option.",
    RET: "A fused growth gene with a highly targeted pill option.",
    NTRK: "A rare fusion that can respond dramatically to TRK-targeted pills.",
    PSMA: "A prostate-cancer surface marker that allows targeted radiation delivery.",
    "FOLR1 (FRα)": "A surface marker that allows an antibody-drug to deliver chemo directly to the cancer.",
    CLDN18: "A stomach-cancer marker (Claudin 18.2) with a new targeted antibody.",
    "CLDN18.2": "A stomach-cancer marker with a new targeted antibody.",
  };
  return map[gene] || `This finding points toward ${therapy} as an option your care team may discuss.`;
}


const inputClass = "mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--surface2)] px-3 py-2.5 text-sm outline-none focus:ring-2 ring-teal-600";
const labelClass = "text-xs font-semibold tracking-wide uppercase text-[var(--dim)]";

function AuthPanel({ onAuthenticated }: { onAuthenticated: () => void }) {
  const initialInvite = (() => { try { return new URLSearchParams(window.location.search).get("invite") || ""; } catch { return ""; } })();
  const [mode, setMode] = useState<"login" | "register" | "mfa">(initialInvite ? "register" : "login");
  const [form, setForm] = useState({ inviteToken: initialInvite, name: "", email: "", password: "", npi: "", licenseNumber: "", licenseState: "", totpCode: "", mfaCode: "" });
  const [mfaData, setMfaData] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const set = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement>) => setForm(prev => ({ ...prev, [key]: event.target.value }));
  const run = async (action: () => Promise<void>) => { setError(""); setMessage(""); try { await action(); } catch (e) { setError(e instanceof Error ? e.message : "Request failed."); } };

  return (
    <section className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-5 md:p-6 shadow-sm" aria-label="Doctor account access">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold">Doctor account access</h2>
          <p className="text-sm text-[var(--dim)] mt-1 max-w-2xl">Accounts are invite-only. Registration verifies an individual NPI against NPPES, collects a state license for admin review, and requires TOTP MFA before approval.</p>
        </div>
        <div className="flex rounded-full border border-[var(--border)] p-1" role="group" aria-label="Account action">
          {(["login", "register", "mfa"] as const).map(value => (
            <button key={value} onClick={() => setMode(value)} className={`px-3 py-1.5 rounded-full text-xs font-semibold ${mode === value ? "bg-teal-700 text-white" : ""}`}>{value === "mfa" ? "Confirm MFA" : value === "login" ? "Sign in" : "Register"}</button>
          ))}
        </div>
      </div>
      {error && <p className="mt-4 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 px-4 py-3 text-sm" role="alert">{error}</p>}
      {message && <p className="mt-4 rounded-xl bg-teal-50 border border-teal-200 text-teal-900 px-4 py-3 text-sm">{message}</p>}

      {mode === "login" && (
        <form className="grid md:grid-cols-3 gap-3 mt-5" onSubmit={e => { e.preventDefault(); void run(async () => { await api.login(form.email, form.password, form.totpCode); onAuthenticated(); }); }}>
          <div><label className={labelClass} htmlFor="login-email">Email</label><input id="login-email" type="email" autoComplete="email" required value={form.email} onChange={set("email")} className={inputClass} /></div>
          <div><label className={labelClass} htmlFor="login-password">Password</label><input id="login-password" type="password" autoComplete="current-password" required value={form.password} onChange={set("password")} className={inputClass} /></div>
          <div><label className={labelClass} htmlFor="login-totp">Authenticator code</label><input id="login-totp" inputMode="numeric" autoComplete="one-time-code" required value={form.totpCode} onChange={set("totpCode")} className={inputClass} /></div>
          <button className="md:col-span-3 bg-teal-700 text-white font-semibold rounded-xl py-3">Sign in securely</button>
        </form>
      )}

      {mode === "register" && (
        <form className="grid md:grid-cols-2 gap-3 mt-5" onSubmit={e => { e.preventDefault(); void run(async () => { await api.register({ inviteToken: form.inviteToken, name: form.name, email: form.email, password: form.password, npi: form.npi, licenseNumber: form.licenseNumber, licenseState: form.licenseState.toUpperCase() }); setMessage("Account created as pending. Now enroll and confirm MFA below; an admin must approve the account before sign-in can access the workspace."); setMode("mfa"); }); }}>
          <div className="md:col-span-2"><label className={labelClass} htmlFor="register-invite">Invite token</label><input id="register-invite" required value={form.inviteToken} onChange={set("inviteToken")} className={inputClass} /></div>
          <div><label className={labelClass} htmlFor="register-name">Full name</label><input id="register-name" autoComplete="name" required value={form.name} onChange={set("name")} className={inputClass} /></div>
          <div><label className={labelClass} htmlFor="register-email">Email</label><input id="register-email" type="email" autoComplete="email" required value={form.email} onChange={set("email")} className={inputClass} /></div>
          <div><label className={labelClass} htmlFor="register-password">Password (12+ characters)</label><input id="register-password" type="password" autoComplete="new-password" required minLength={12} value={form.password} onChange={set("password")} className={inputClass} /></div>
          <div><label className={labelClass} htmlFor="register-npi">Individual NPI</label><input id="register-npi" inputMode="numeric" required value={form.npi} onChange={set("npi")} className={inputClass} /></div>
          <div><label className={labelClass} htmlFor="register-license">License number</label><input id="register-license" required value={form.licenseNumber} onChange={set("licenseNumber")} className={inputClass} /></div>
          <div><label className={labelClass} htmlFor="register-state">License state</label><input id="register-state" required maxLength={2} placeholder="NY" value={form.licenseState} onChange={set("licenseState")} className={inputClass} /></div>
          <button className="md:col-span-2 bg-[#0B1220] text-white font-semibold rounded-xl py-3">Create pending account</button>
        </form>
      )}

      {mode === "mfa" && (
        <div className="mt-5 space-y-4">
          <form className="grid md:grid-cols-2 gap-3" onSubmit={e => { e.preventDefault(); void run(async () => { const data = await api.beginMfa(form.email, form.password); setMfaData(data); setMessage("Add the secret or otpauth URI to your authenticator app, then confirm a current six-digit code."); }); }}>
            <div><label className={labelClass} htmlFor="mfa-email">Email</label><input id="mfa-email" type="email" required value={form.email} onChange={set("email")} className={inputClass} /></div>
            <div><label className={labelClass} htmlFor="mfa-password">Password</label><input id="mfa-password" type="password" required value={form.password} onChange={set("password")} className={inputClass} /></div>
            <button className="md:col-span-2 border border-[var(--border)] font-semibold rounded-xl py-3">1 · Begin MFA enrollment</button>
          </form>
          {mfaData && <div className="rounded-xl bg-[var(--surface2)] border border-[var(--border)] p-4 text-sm break-all"><p><strong>Secret:</strong> <code>{mfaData.secret}</code></p><p className="mt-2"><strong>otpauth URI:</strong> <code>{mfaData.otpauthUri}</code></p></div>}
          <form className="flex flex-col md:flex-row gap-3" onSubmit={e => { e.preventDefault(); void run(async () => { await api.confirmMfa(form.email, form.password, form.mfaCode); setMessage("MFA confirmed. An administrator can now approve this pending account. After approval, sign in with your password and a fresh authenticator code."); setMode("login"); }); }}>
            <div className="flex-1"><label className={labelClass} htmlFor="mfa-code">Six-digit code</label><input id="mfa-code" inputMode="numeric" required value={form.mfaCode} onChange={set("mfaCode")} className={inputClass} /></div>
            <button className="self-end bg-teal-700 text-white font-semibold rounded-xl px-5 py-3">2 · Confirm MFA</button>
          </form>
        </div>
      )}
      <p className="text-xs text-[var(--dim)] mt-4">No account can be created without an admin-issued invite. State licenses are reviewed by the approving admin; NPPES failures degrade to manual review rather than approval.</p>
    </section>
  );
}

function PlatformTools({ user, onChanged }: { user: PlatformUser; onChanged: () => void }) {
  const qcTools = useQueryClient();
  const [tab, setTab] = useState<"submit" | "mine" | "review" | "admin">(user.role === "reviewer" ? "review" : "submit");
  const [submission, setSubmission] = useState({ title: "", summary: "", biomarkers: "", cancerType: "", sourceUrl: "" });
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<Role>("doctor");
  const [inviteResult, setInviteResult] = useState("");
  const [notes, setNotes] = useState<Record<string, string>>({});
  const mineQ = useQuery({ queryKey: ["submissions"], queryFn: api.listSubmissions, enabled: user.role === "doctor" || user.role === "admin" });
  const reviewQ = useQuery({ queryKey: ["review-queue"], queryFn: api.listReviewQueue, enabled: user.role === "reviewer" || user.role === "admin" });
  const usersQ = useQuery({ queryKey: ["admin-users"], queryFn: api.listUsers, enabled: user.role === "admin" });
  const refresh = () => { qcTools.invalidateQueries({ queryKey: ["submissions"] }); qcTools.invalidateQueries({ queryKey: ["review-queue"] }); qcTools.invalidateQueries({ queryKey: ["admin-users"] }); onChanged(); };
  const tabs = [
    ...((user.role === "doctor" || user.role === "admin") ? [{ id: "submit" as const, label: "New submission" }, { id: "mine" as const, label: "My submissions" }] : []),
    ...((user.role === "reviewer" || user.role === "admin") ? [{ id: "review" as const, label: `Review queue${reviewQ.data ? ` (${reviewQ.data.length})` : ""}` }] : []),
    ...(user.role === "admin" ? [{ id: "admin" as const, label: "Admin" }] : []),
  ];
  return (
    <section className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-4 md:p-5 no-print" aria-label="Research submissions and administration">
      <div className="flex flex-wrap justify-between gap-3">
        <div><h2 className="font-bold text-lg">Research & Review</h2><p className="text-xs text-[var(--dim)] mt-1">Submissions are stored in D1 and always start in pending review.</p></div>
        <div className="flex flex-wrap gap-2">{tabs.map(t => <button key={t.id} onClick={() => setTab(t.id)} className={`text-xs font-semibold rounded-full px-3 py-2 ${tab === t.id ? "bg-teal-700 text-white" : "border border-[var(--border)]"}`}>{t.label}</button>)}</div>
      </div>
      {tab === "submit" && (user.role === "doctor" || user.role === "admin") && (
        <form className="grid md:grid-cols-2 gap-3 mt-4" onSubmit={async e => { e.preventDefault(); await api.createSubmission({ title: submission.title, summary: submission.summary, biomarkers: submission.biomarkers.split(/[,\n]/).map(v => v.trim()).filter(Boolean), cancerType: submission.cancerType, sourceUrl: submission.sourceUrl || undefined }); setSubmission({ title: "", summary: "", biomarkers: "", cancerType: "", sourceUrl: "" }); refresh(); setTab("mine"); }}>
          <div className="md:col-span-2"><label className={labelClass}>Title</label><input required value={submission.title} onChange={e => setSubmission({ ...submission, title: e.target.value })} className={inputClass} /></div>
          <div className="md:col-span-2"><label className={labelClass}>Summary</label><textarea required minLength={20} rows={3} value={submission.summary} onChange={e => setSubmission({ ...submission, summary: e.target.value })} className={inputClass} /></div>
          <div><label className={labelClass}>Biomarkers (comma separated)</label><input required value={submission.biomarkers} onChange={e => setSubmission({ ...submission, biomarkers: e.target.value })} className={inputClass} /></div>
          <div><label className={labelClass}>Cancer type</label><input required value={submission.cancerType} onChange={e => setSubmission({ ...submission, cancerType: e.target.value })} className={inputClass} /></div>
          <div className="md:col-span-2"><label className={labelClass}>Source URL (optional)</label><input value={submission.sourceUrl} onChange={e => setSubmission({ ...submission, sourceUrl: e.target.value })} className={inputClass} /></div>
          <button className="md:col-span-2 bg-teal-700 text-white rounded-xl py-3 font-semibold">Submit for review</button>
        </form>
      )}
      {tab === "mine" && <div className="mt-4 space-y-2">{mineQ.isPending ? <p>Loading…</p> : (mineQ.data || []).length === 0 ? <p className="text-sm text-[var(--dim)]">No submissions yet.</p> : mineQ.data!.map(s => <article key={s.id} className="border border-[var(--border)] rounded-xl p-3"><div className="flex justify-between gap-2"><strong className="text-sm">{s.title}</strong><span className="text-xs font-mono2">{s.status} · v{s.version}</span></div><p className="text-sm text-[var(--dim)] mt-1">{s.summary}</p><p className="text-xs mt-2">{s.cancerType} · {s.biomarkers.join(", ")}</p></article>)}</div>}
      {tab === "review" && <div className="mt-4 space-y-2">{reviewQ.isPending ? <p>Loading…</p> : (reviewQ.data || []).length === 0 ? <p className="text-sm text-[var(--dim)]">The review queue is empty.</p> : reviewQ.data!.map(s => <article key={s.id} className="border border-[var(--border)] rounded-xl p-3"><div className="flex justify-between gap-2"><strong className="text-sm">{s.title}</strong><span className="text-xs font-mono2">{s.status}</span></div><p className="text-sm text-[var(--dim)] mt-1">{s.summary}</p><div className="flex flex-col md:flex-row gap-2 mt-3"><input aria-label={`Review note for ${s.title}`} placeholder="Review note (required to reject)" value={notes[s.id] || ""} onChange={e => setNotes({ ...notes, [s.id]: e.target.value })} className="flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface2)] px-3 py-2 text-sm" /><button onClick={async () => { await api.approveSubmission(s.id, notes[s.id]); refresh(); }} className="bg-teal-700 text-white rounded-lg px-4 py-2 text-sm font-semibold">Approve</button><button onClick={async () => { await api.rejectSubmission(s.id, notes[s.id] || ""); refresh(); }} className="border border-rose-300 text-rose-700 rounded-lg px-4 py-2 text-sm font-semibold">Reject</button></div></article>)}</div>}
      {tab === "admin" && user.role === "admin" && (
        <div className="mt-4 space-y-5">
          <form className="flex flex-col md:flex-row gap-2" onSubmit={async e => { e.preventDefault(); const result = await api.createInvite(inviteEmail, inviteRole); setInviteResult(`${window.location.origin}/?invite=${result.token}`); }}>
            <input type="email" placeholder="Invitee email (optional)" value={inviteEmail} onChange={e => setInviteEmail(e.target.value)} className="flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface2)] px-3 py-2 text-sm" />
            <select value={inviteRole} onChange={e => setInviteRole(e.target.value as Role)} className="rounded-lg border border-[var(--border)] bg-[var(--surface2)] px-3 py-2 text-sm"><option value="doctor">Doctor</option><option value="reviewer">Reviewer</option><option value="admin">Admin</option></select>
            <button className="bg-[#0B1220] text-white rounded-lg px-4 py-2 text-sm font-semibold">Create invite</button>
          </form>
          {inviteResult && <p className="text-xs break-all rounded-xl bg-[var(--surface2)] border border-[var(--border)] p-3">Share this registration link once: <code>{inviteResult}</code></p>}
          <div className="space-y-2">{(usersQ.data || []).map(u => <div key={u.id} className="flex flex-wrap items-center justify-between gap-2 border border-[var(--border)] rounded-xl p-3"><div><strong className="text-sm">{u.name}</strong><span className="text-xs text-[var(--dim)]"> · {u.email} · {u.role} · {u.status} · NPI {u.npiVerification}</span></div><div className="flex gap-2">{u.status === "pending" && <button onClick={async () => { await api.approveUser(u.id); refresh(); }} className="bg-teal-700 text-white rounded-lg px-3 py-1.5 text-xs font-semibold">Approve</button>}{u.status !== "suspended" && u.id !== user.id && <button onClick={async () => { await api.suspendUser(u.id); refresh(); }} className="border border-[var(--border)] rounded-lg px-3 py-1.5 text-xs">Suspend</button>}</div></div>)}</div>
        </div>
      )}
    </section>
  );
}

export function App() {
  const qc = useQueryClient();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [pipelineStep, setPipelineStep] = useState(-1);
  const [isDragging, setIsDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // Theme — darker clinical theme
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    try { return (localStorage.getItem("obm-theme") as ThemeMode) || "system"; } catch { return "system"; }
  });
  useEffect(() => {
    const root = document.documentElement;
    if (themeMode === "clinical-dark") { root.dataset.theme = "clinical-dark"; root.style.colorScheme = "dark"; }
    else if (themeMode === "light") { root.dataset.theme = "light"; root.style.colorScheme = "light"; }
    else { delete root.dataset.theme; root.style.colorScheme = ""; }
    try { localStorage.setItem("obm-theme", themeMode); } catch {}
  }, [themeMode]);
  const isClinicalDark = themeMode === "clinical-dark";

  // Patient summary
  const [showSummary, setShowSummary] = useState(false);
  const [summaryCopied, setSummaryCopied] = useState(false);

  // form
  const [label, setLabel] = useState("");
  const [cancerType, setCancerType] = useState(CANCER_TYPES[0]!);
  const [stage, setStage] = useState("Stage IV");
  const [histology, setHistology] = useState("");
  const [sampleType, setSampleType] = useState(SAMPLE_TYPES[0]!);
  const [priorTherapy, setPriorTherapy] = useState("");
  const [showForm, setShowForm] = useState(true);
  const [cancerFilter, setCancerFilter] = useState("All");

  const authQ = useQuery({ queryKey: ["auth-me"], queryFn: api.me });
  const currentUser: PlatformUser | null = authQ.data?.user ?? null;
  const isActive = currentUser?.status === "active";
  const listQ = useQuery({ queryKey: ["cases"], queryFn: () => api.listCases({ limit: 50 }), enabled: isActive });
  const allCases = listQ.data?.cases ?? [];
  const cases = cancerFilter === "All" ? allCases : allCases.filter(c => c.cancerType === cancerFilter);
  const stats = listQ.data?.stats ?? { totalCases: 0, totalUploads: 0, totalMatches: 0, actionable: 0 };

  const selected: CaseRow | undefined = allCases.find(c => c.id === selectedId) ?? allCases[0];

  useEffect(() => {
    if (!selectedId && allCases.length > 0) setSelectedId(allCases[0]!.id);
  }, [allCases, selectedId]);

  const detailQ = useQuery({
    queryKey: ["detail", selected?.id],
    queryFn: () => api.getCaseDetail({ caseId: selected!.id }),
    enabled: !!selected && isActive,
  });
  const uploads: Detail["uploads"] = detailQ.data?.uploads ?? [];
  const matches: Detail["matches"] = detailQ.data?.matches ?? [];

  const createMut = useMutation({
    mutationFn: () => api.createCase({ label: label.trim() || `Case ${new Date().toLocaleDateString()} — ${cancerType}`, cancerType, stage, histology, sampleType, priorTherapy }),
    onSuccess: (r) => { setSelectedId(r.id); setLabel(""); setHistology(""); setPriorTherapy(""); qc.invalidateQueries({ queryKey: ["cases"] }); },
  });
  const deleteMut = useMutation({ mutationFn: (id: number) => api.deleteCase({ id }), onSuccess: () => { setSelectedId(null); qc.invalidateQueries({ queryKey: ["cases"] }); qc.invalidateQueries({ queryKey: ["detail"] }); } });
  const addUploadMut = useMutation({
    mutationFn: (file: File) => api.uploadResearch(selected!.id, file),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["detail"] }); qc.invalidateQueries({ queryKey: ["cases"] }); },
  });
  const deleteUploadMut = useMutation({ mutationFn: (id: number) => api.deleteUpload({ id }), onSuccess: () => { qc.invalidateQueries({ queryKey: ["detail"] }); qc.invalidateQueries({ queryKey: ["cases"] }); } });
  const runMut = useMutation({
    mutationFn: (id: number) => api.runMatch({ caseId: id }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["detail"] }); qc.invalidateQueries({ queryKey: ["cases"] }); },
  });

  const handleRun = async () => {
    if (!selected) return;
    setPipelineStep(0);
    for (let i = 0; i < 4; i++) {
      setPipelineStep(i);
      await new Promise(r => setTimeout(r, 650));
    }
    await runMut.mutateAsync(selected.id);
    setPipelineStep(4);
    setTimeout(() => setPipelineStep(-1), 1200);
  };

  const handleFiles = async (files: FileList | null) => {
    if (!files || !selected) return;
    for (const file of Array.from(files)) {
      await addUploadMut.mutateAsync(file);
    }
  };

  const addSampleBiomarkerList = async () => {
    const file = new File([`${SAMPLE_BIOMARKERS.join("\n")}\n`], "sample-biomarkers.txt", { type: "text/plain" });
    await addUploadMut.mutateAsync(file);
  };

  const buildSummaryText = useCallback(() => {
    if (!selected) return "";
    const date = new Date().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
    const lines: string[] = [];
    lines.push("PATIENT SUMMARY — Precision Oncology Biomarker Results");
    lines.push("=".repeat(56));
    lines.push(`Prepared: ${date}  •  For discussion with your care team`);
    lines.push("");
    lines.push(`Case: ${selected.label}`);
    lines.push(`Cancer type: ${selected.cancerType} — ${selected.stage}${selected.histology ? ` • ${selected.histology}` : ""}`);
    lines.push(`Test type: ${selected.sampleType}`);
    if (selected.priorTherapy) lines.push(`Prior treatment: ${selected.priorTherapy}`);
    lines.push(`Files reviewed: ${uploads.length}  •  Findings: ${matches.length}`);
    lines.push("");
    lines.push("WHAT WE FOUND — IN PLAIN LANGUAGE");
    lines.push("-".repeat(56));
    if (matches.length === 0) {
      lines.push("No biomarker match run yet. Run the AI match to generate findings.");
    } else {
      matches.forEach((m, i) => {
        lines.push(`${i + 1}. ${m.gene} ${m.variant} — ${m.classification} (${m.confidence}% confidence)`);
        lines.push(`   ${plainExplanation(m.gene, m.therapy)}`);
        lines.push(`   Possible trial to discuss: ${m.therapy}  •  Evidence: ${m.evidenceLevel}  •  Trial record: ${m.trialCount}`);
        if (m.vaf > 0) lines.push(`   Amount in sample (VAF): ${m.vaf.toFixed(1)}%`);
        lines.push(`   Clinician note: ${m.rationale}`);
        lines.push("");
      });
    }
    lines.push("WHAT THIS MEANS");
    lines.push("-".repeat(56));
    lines.push("• Biomarkers are clues in the cancer's DNA/proteins that can point to treatments");
    lines.push("  most likely to help — sometimes pills instead of, or in addition to, chemo.");
    lines.push("• A match does not guarantee a treatment will work, and not every match");
    lines.push("  is available right away — your oncologist weighs your overall health,");
    lines.push("  prior treatments, and preferences.");
    lines.push("• Trial numbers show how many research studies were found for that finding;");
    lines.push("  your team can check eligibility and locations with you.");
    lines.push("");
    lines.push("QUESTIONS TO ASK YOUR ONCOLOGIST");
    lines.push("-".repeat(56));
    lines.push("1. Which of these findings is most actionable for me right now?");
    lines.push("2. Should germline (inherited) testing be confirmed with a blood/saliva test?");
    lines.push("3. Am I eligible for any of the trials listed, and where are they?");
    lines.push("4. What are the benefits, side effects, and alternatives for the top option?");
    lines.push("5. When should we re-test (for example, with a liquid biopsy) if treatment stops working?");
    lines.push("");
    lines.push("—".repeat(56));
    lines.push("Research prototype — not medical advice. Always review");
    lines.push("with a qualified oncologist / molecular tumor board before decisions.");
    return lines.join("\n");
  }, [selected, uploads.length, matches]);

  const downloadSummary = (format: "txt" | "html") => {
    if (!selected) return;
    let blob: Blob; let filename: string;
    if (format === "txt") {
      blob = new Blob([buildSummaryText()], { type: "text/plain;charset=utf-8" });
      filename = `patient-summary-${selected.label.replace(/[^a-z0-9]+/gi, "-").slice(0, 40)}.txt`;
    } else {
      const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
      const rows = matches.map(m => `<tr><td><strong>${esc(m.gene)} ${esc(m.variant)}</strong><br><small>${esc(plainExplanation(m.gene, m.therapy))}</small></td><td>${esc(m.therapy)}</td><td>${esc(m.evidenceLevel)}</td><td>${m.trialCount}</td><td>${m.confidence}%</td></tr>`).join("");
      const html = `<!doctype html><html><head><meta charset="utf-8"><title>Patient Summary — ${esc(selected.label)}</title><style>body{font-family:system-ui,Arial,sans-serif;max-width:760px;margin:32px auto;padding:0 20px;color:#0b1220;line-height:1.5}h1{font-size:22px}table{width:100%;border-collapse:collapse;margin:16px 0}td,th{border:1px solid #d9e2dc;padding:8px;text-align:left;font-size:14px}th{background:#0B1220;color:#fff}.meta{background:#f3f6f3;padding:12px 16px;border-radius:10px}footer{font-size:12px;color:#64746d;margin-top:24px}</style></head><body><h1>Patient Summary — Biomarker Results</h1><div class="meta"><strong>Case:</strong> ${esc(selected.label)}<br><strong>Cancer:</strong> ${esc(selected.cancerType)} — ${esc(selected.stage)}${selected.histology ? ` • ${esc(selected.histology)}` : ""}<br><strong>Test:</strong> ${esc(selected.sampleType)} • <strong>Prepared:</strong> ${new Date().toLocaleDateString()}</div><h2>Findings &amp; options to discuss</h2><table><thead><tr><th>Finding</th><th>Trial</th><th>Match score</th><th>Records</th><th>Score</th></tr></thead><tbody>${rows || "<tr><td colspan='5'>No matches yet — run the AI match first.</td></tr>"}</tbody></table><h2>Questions to ask your oncologist</h2><ol><li>Which finding is most actionable for me right now?</li><li>Should inherited (germline) testing be confirmed?</li><li>Am I eligible for any of these trials?</li><li>What are benefits, side effects, and alternatives?</li></ol><footer>Research prototype — not medical advice. Review with a qualified oncologist / molecular tumor board.</footer></body></html>`;
      blob = new Blob([html], { type: "text/html;charset=utf-8" });
      filename = `patient-summary-${selected.label.replace(/[^a-z0-9]+/gi, "-").slice(0, 40)}.html`;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };

  const copySummary = async () => {
    try { await navigator.clipboard.writeText(buildSummaryText()); setSummaryCopied(true); setTimeout(() => setSummaryCopied(false), 2000); } catch {}
  };

  if (authQ.isPending) {
    return <div className="min-h-screen bg-[var(--bg)] text-[var(--text)] flex items-center justify-center p-6"><p className="font-semibold">Checking your secure session…</p></div>;
  }

  if (!currentUser) {
    return (
      <div className={`min-h-screen bg-[var(--bg)] text-[var(--text)] pb-10 ${isClinicalDark ? "clinical-dark" : ""}`}>
        <main className="max-w-5xl mx-auto px-4 pt-10">
          <p className="text-[11px] font-mono2 tracking-[0.18em] uppercase text-teal-700">Cloudflare Worker · D1 · Invite-only</p>
          <h1 className="text-4xl font-bold mt-2">Precision Oncology Biomarker Matcher</h1>
          <p className="text-[var(--dim)] mt-2 mb-6 max-w-2xl">Sign in with an approved doctor, reviewer, or admin account to use the live D1-backed case workspace and Lenhard trial matcher.</p>
          <AuthPanel onAuthenticated={() => { qc.invalidateQueries({ queryKey: ["auth-me"] }); qc.invalidateQueries({ queryKey: ["cases"] }); }} />
          <p className="text-center text-xs text-[var(--dim)] mt-6">Static HTML5 guides are available under <a className="underline" href="/static/">/static/</a>. Research prototype — not for clinical decision-making.</p>
        </main>
      </div>
    );
  }

  if (!isActive) {
    return (
      <div className="min-h-screen bg-[var(--bg)] text-[var(--text)] flex items-center justify-center p-6">
        <main className="max-w-xl w-full bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-6">
          <p className="text-[11px] font-mono2 tracking-widest uppercase text-teal-700">Account {currentUser.status}</p>
          <h1 className="text-2xl font-bold mt-2">Workspace locked until approval</h1>
          <p className="text-sm text-[var(--dim)] mt-2">{currentUser.name} · {currentUser.email} · {currentUser.role}. MFA status: {currentUser.mfaConfirmedAt ? "confirmed" : "not confirmed"}. An administrator must approve this account before cases, submissions, and review tools unlock.</p>
          <button onClick={async () => { await api.logout(); qc.invalidateQueries({ queryKey: ["auth-me"] }); }} className="mt-5 bg-[#0B1220] text-white rounded-xl px-4 py-2.5 text-sm font-semibold">Sign out</button>
        </main>
      </div>
    );
  }

  const pipeline = [
    { label: "Ingest", desc: "Validate biomarker lists" },
    { label: "Extract", desc: "Recognized gene symbols only" },
    { label: "Cross-Reference", desc: "Cloudflare D1 trial criteria" },
    { label: "Rank", desc: "Lenhard engine match score" },
  ];

  const coveredTypes = Object.keys(CANCER_GROUPS).length;

  return (
    <div className={`min-h-screen bg-[var(--bg)] text-[var(--text)] pb-10 ${isClinicalDark ? "clinical-dark" : ""}`}>
      {/* Top bench bar */}
      <div className="text-white" style={{ background: "var(--header-bg)" }}>
        <div className="max-w-7xl mx-auto px-4 pt-5 pb-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="flex h-2.5 w-2.5 rounded-full bg-emerald-400 animate-pulse" />
                <span className="text-[11px] font-mono2 tracking-[0.18em] uppercase text-emerald-300">Engine Online · Cloudflare D1 Trial Catalog · Research Prototype</span>
                <span className="text-[10px] font-mono2 px-2 py-0.5 rounded-full bg-teal-500/20 border border-teal-500/40 text-teal-200">{CANCER_TYPES.length - 1} CANCER TYPES + RARE</span>
                {isClinicalDark && <span className="text-[10px] font-mono2 px-2 py-0.5 rounded-full bg-indigo-500/20 border border-indigo-400/40 text-indigo-200">🌙 CLINICAL DARK</span>}
              </div>
              <h1 className="mt-2 text-[28px] leading-8 md:text-4xl font-bold tracking-tight">Precision Oncology<br className="hidden md:block" /> Biomarker Matcher</h1>
              <p className="mt-2 text-sm text-slate-300 max-w-xl">Upload a strict, de-identified biomarker list — the Lenhard engine compares it with the trial criteria actually stored in Cloudflare D1 and ranks the resulting trial matches for tumor-board review.</p>
            </div>
            <div className="flex flex-col items-end gap-3">
              <div className="flex gap-2 md:gap-3">
                {[
                  { v: stats.totalCases, l: "Cases" },
                  { v: stats.totalUploads, l: "Files" },
                  { v: stats.totalMatches, l: "Matches" },
                  { v: stats.actionable, l: "Actionable" },
                ].map(s => (
                  <div key={s.l} className="bg-white/10 border border-white/10 rounded-xl px-3 py-2 text-center min-w-[64px]">
                    <div className="text-xl font-bold leading-none">{s.v}</div>
                    <div className="text-[10px] tracking-widest uppercase text-slate-300 mt-1">{s.l}</div>
                  </div>
                ))}
              </div>
              {/* Theme toggle — darker clinical theme */}
              <div className="flex items-center gap-1 bg-white/10 border border-white/15 rounded-full p-1" role="group" aria-label="Theme">
                {([["system", "◐ Auto"], ["light", "☀ Light"], ["clinical-dark", "🌙 Clinical Dark"]] as [ThemeMode, string][]).map(([mode, lab]) => (
                  <button key={mode} onClick={() => setThemeMode(mode)} aria-label={`Theme: ${lab}`} aria-pressed={themeMode === mode} className={`text-[11px] font-semibold px-3 py-1.5 rounded-full transition ${themeMode === mode ? "bg-teal-500 text-white shadow" : "text-slate-200 hover:bg-white/10"}`}>{lab}</button>
                ))}
              </div>
            </div>
          </div>

          {/* Pipeline */}
          <div className="mt-5 bg-white/[0.06] border border-white/10 rounded-2xl p-3 md:p-4 no-print">
            <div className="flex items-center justify-between mb-3 px-1">
              <span className="text-[11px] font-mono2 tracking-widest uppercase text-slate-300">AI Matching Pipeline</span>
              <span className="text-[11px] font-mono2 text-teal-300">{pipelineStep >= 0 && pipelineStep < 4 ? `RUNNING — ${pipeline[pipelineStep]?.label}` : pipelineStep === 4 ? "✓ COMPLETE" : "READY"}</span>
            </div>
            <div className="grid grid-cols-4 gap-2">
              {pipeline.map((p, i) => {
                const active = pipelineStep === i;
                const done = pipelineStep > i || pipelineStep === 4;
                return (
                  <div key={p.label} className={`rounded-xl border px-3 py-3 transition-all ${active ? "bg-teal-500 text-white border-teal-400 scale-[1.02]" : done ? "bg-teal-500/20 border-teal-500/40 text-teal-100" : "bg-white/5 border-white/10 text-slate-200"}`}>
                    <div className="flex items-center gap-2">
                      <span className={`flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-mono2 font-bold ${active || done ? "bg-white text-teal-700" : "bg-white/15 text-white"}`}>{done ? "✓" : i + 1}</span>
                      <span className="font-semibold text-sm">{p.label}</span>
                    </div>
                    <p className={`mt-1.5 text-[11px] leading-tight hidden md:block ${active ? "text-teal-50" : "text-slate-400"}`}>{p.desc}</p>
                    {active && <div className="mt-2 h-1 rounded bg-white/30 overflow-hidden"><div className="h-full w-2/3 bg-white animate-pulse" /></div>}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Cancer coverage strip */}
          <div className="mt-3 flex gap-2 overflow-x-auto pb-1 no-print" aria-label="Cancer type coverage">
            {Object.entries(CANCER_GROUPS).map(([group, types]) => (
              <div key={group} className="shrink-0 bg-white/[0.05] border border-white/10 rounded-xl px-3 py-2">
                <p className="text-[10px] font-mono2 tracking-widest uppercase text-teal-300">{group}</p>
                <p className="text-[11px] text-slate-300 mt-0.5 whitespace-nowrap">{types.join(" · ")}</p>
              </div>
            ))}
            <div className="shrink-0 bg-teal-500/15 border border-teal-500/30 rounded-xl px-3 py-2 flex items-center"><p className="text-[11px] text-teal-100 whitespace-nowrap">✓ {coveredTypes} groups · dedicated biomarker library per type</p></div>
          </div>
        </div>
      </div>

      <main className="max-w-7xl mx-auto px-4 -mt-1">
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3 no-print">
          <p className="text-sm"><strong>{currentUser.name}</strong> <span className="text-[var(--dim)]">· {currentUser.role} · {currentUser.email} · D1 workspace</span></p>
          <div className="flex gap-2">
            <a href="/static/" className="text-xs font-semibold border border-[var(--border)] rounded-full px-3 py-2">Static HTML5 pages</a>
            <button onClick={async () => { await api.logout(); qc.invalidateQueries({ queryKey: ["auth-me"] }); qc.invalidateQueries({ queryKey: ["cases"] }); }} className="text-xs font-semibold border border-[var(--border)] rounded-full px-3 py-2">Sign out</button>
          </div>
        </div>
        <div className="mt-4"><PlatformTools user={currentUser} onChanged={() => qc.invalidateQueries({ queryKey: ["cases"] })} /></div>
        <div className="grid lg:grid-cols-[360px_1fr] gap-5 mt-5 items-start">
          {/* Left column */}
          <div className="space-y-4 no-print">
            {/* New case */}
            <section className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl overflow-hidden">
              <button onClick={() => setShowForm(!showForm)} className="w-full flex items-center justify-between px-4 py-3.5" aria-label="Toggle new case form">
                <span className="font-bold text-[15px]">＋ New Case Intake</span>
                <span className="text-xs text-[var(--dim)] font-mono2">{showForm ? "COLLAPSE" : "EXPAND"}</span>
              </button>
              {showForm && (
                <div className="px-4 pb-4 space-y-3 border-t border-[var(--border)] pt-4">
                  <div>
                    <label htmlFor="case-label" className="text-xs font-semibold tracking-wide uppercase text-[var(--dim)]">Case label (de-identified)</label>
                    <input id="case-label" value={label} onChange={e => setLabel(e.target.value)} placeholder="e.g. MTB-2026-041 · 58F" className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--surface2)] px-3 py-2.5 text-sm outline-none focus:ring-2 ring-teal-600" />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label htmlFor="cancer-type" className="text-xs font-semibold tracking-wide uppercase text-[var(--dim)]">Cancer type</label>
                      <select id="cancer-type" value={cancerType} onChange={e => setCancerType(e.target.value)} className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--surface2)] px-2 py-2.5 text-sm">
                        {Object.entries(CANCER_GROUPS).map(([group, types]) => (
                          <optgroup key={group} label={group}>{types.map(t => <option key={t}>{t}</option>)}</optgroup>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label htmlFor="stage" className="text-xs font-semibold tracking-wide uppercase text-[var(--dim)]">Stage</label>
                      <select id="stage" value={stage} onChange={e => setStage(e.target.value)} className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--surface2)] px-2 py-2.5 text-sm">
                        {STAGES.map(s => <option key={s}>{s}</option>)}
                      </select>
                    </div>
                  </div>
                  <div>
                    <label htmlFor="histology" className="text-xs font-semibold tracking-wide uppercase text-[var(--dim)]">Histology / subtype</label>
                    <input id="histology" value={histology} onChange={e => setHistology(e.target.value)} placeholder="Adenocarcinoma, HR+/HER2−, clear cell, serous…" className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--surface2)] px-3 py-2.5 text-sm outline-none focus:ring-2 ring-teal-600" />
                  </div>
                  <div>
                    <label htmlFor="sample-type" className="text-xs font-semibold tracking-wide uppercase text-[var(--dim)]">Sample / assay</label>
                    <select id="sample-type" value={sampleType} onChange={e => setSampleType(e.target.value)} className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--surface2)] px-2 py-2.5 text-sm">
                      {SAMPLE_TYPES.map(s => <option key={s}>{s}</option>)}
                    </select>
                  </div>
                  <div>
                    <label htmlFor="prior" className="text-xs font-semibold tracking-wide uppercase text-[var(--dim)]">Prior therapy</label>
                    <textarea id="prior" value={priorTherapy} onChange={e => setPriorTherapy(e.target.value)} rows={2} placeholder="e.g. Carbo/pem ×4, pembro maintenance…" className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--surface2)] px-3 py-2.5 text-sm outline-none focus:ring-2 ring-teal-600 resize-none" />
                  </div>
                  {createMut.isError && <p className="text-xs text-rose-700" role="alert">{createMut.error instanceof Error ? createMut.error.message : "Could not create the case."}</p>}
                  <button onClick={() => createMut.mutate()} disabled={createMut.isPending} aria-label="Create case" className="w-full bg-[#0B1220] dark:bg-teal-600 text-white font-semibold py-3 rounded-xl text-sm disabled:opacity-50" style={isClinicalDark ? { background: "#0d9488" } : undefined}>
                    {createMut.isPending ? "Creating…" : "Create Case → Go to Upload"}
                  </button>
                  <p className="text-[11px] text-[var(--dim)] leading-relaxed">Do not enter real PHI. Use de-identified labels only. The 16 cancer categories plus Rare organize intake; matching uses the current D1 trial catalog.</p>
                </div>
              )}
            </section>

            {/* Case list */}
            <section className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-3">
              <div className="flex items-center justify-between px-1 pb-2">
                <h2 className="font-bold text-sm tracking-wide">CASE QUEUE</h2>
                <span className="text-xs font-mono2 text-[var(--dim)]">{allCases.length} total</span>
              </div>
              <div className="px-1 pb-2">
                <label htmlFor="case-filter" className="sr-only">Filter cases by cancer type</label>
                <select id="case-filter" value={cancerFilter} onChange={e => setCancerFilter(e.target.value)} className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface2)] px-2 py-2 text-xs">
                  <option>All</option>
                  {CANCER_TYPES.map(t => <option key={t}>{t}</option>)}
                </select>
              </div>
              {listQ.isPending ? <p className="text-sm text-[var(--dim)] px-1 py-4">Loading cases…</p> : cases.length === 0 ? (
                <div className="rounded-xl bg-[var(--surface2)] border border-dashed border-[var(--border)] p-4 text-center">
                  <div className="text-2xl">🧬</div>
                  <p className="text-sm font-medium mt-1">{allCases.length === 0 ? "No cases yet" : "No cases for this cancer type"}</p>
                  <p className="text-xs text-[var(--dim)] mt-1">Create your first case above, then upload its research to run a match.</p>
                </div>
              ) : (
                <ul className="space-y-2">
                  {cases.map(c => (
                    <li key={c.id}>
                      <button onClick={() => setSelectedId(c.id)} aria-label={`Select case ${c.label}`} className={`w-full text-left rounded-xl border px-3 py-3 transition ${selected?.id === c.id ? "border-teal-600 bg-teal-50 dark:bg-teal-950/30 ring-1 ring-teal-600" : "border-[var(--border)] bg-[var(--surface2)] hover:border-teal-500"}`}>
                        <div className="flex justify-between gap-2">
                          <span className="font-semibold text-sm leading-tight">{c.label}</span>
                          <span className={`shrink-0 text-[10px] font-mono2 px-1.5 py-0.5 rounded-full border ${c.status === "matched" ? "bg-teal-100 text-teal-800 border-teal-200" : "bg-amber-100 text-amber-800 border-amber-200"}`}>{c.status.toUpperCase()}</span>
                        </div>
                        <p className="text-xs text-[var(--dim)] mt-1">{c.cancerType} · {c.stage}{c.histology ? ` · ${c.histology}` : ""}</p>
                        <p className="text-[11px] font-mono2 text-[var(--dim)] mt-1.5">{c.uploadCount} files · {c.matchCount} matches · {new Date(c.created_at).toLocaleDateString()}</p>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          {/* Right column */}
          <div className="space-y-5 min-w-0">
            {!selected ? (
              <div className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-8 text-center">
                <div className="text-4xl">🔬</div>
                <h2 className="font-bold text-lg mt-3">Start with a case</h2>
                <p className="text-sm text-[var(--dim)] mt-1 max-w-sm mx-auto">Create a case on the left to unlock the research upload zone and AI biomarker matching.</p>
              </div>
            ) : (
              <>
                {/* Selected case header + export */}
                <div className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-4 md:p-5 no-print">
                  <div className="flex flex-wrap justify-between gap-3">
                    <div>
                      <p className="text-[11px] font-mono2 tracking-widest uppercase text-[var(--dim)]">Selected Case · {selected.sampleType}</p>
                      <h2 className="text-xl font-bold mt-0.5">{selected.label}</h2>
                      <p className="text-sm text-[var(--dim)]">{selected.cancerType} — {selected.stage}{selected.histology ? ` · ${selected.histology}` : ""}{selected.priorTherapy ? ` · Prior: ${selected.priorTherapy}` : ""}</p>
                    </div>
                    <div className="flex flex-wrap gap-2 h-fit">
                      <button onClick={() => setShowSummary(true)} aria-label="Open patient summary export" className="text-xs font-semibold bg-teal-700 text-white rounded-lg px-3 py-2">📄 Patient Summary</button>
                      <button onClick={() => downloadSummary("txt")} aria-label="Download patient summary as text" className="text-xs border border-[var(--border)] rounded-lg px-3 py-2">⬇ .txt</button>
                      <button onClick={() => downloadSummary("html")} aria-label="Download patient summary as HTML" className="text-xs border border-[var(--border)] rounded-lg px-3 py-2">⬇ .html</button>
                      <button onClick={() => { if (confirm("Delete this case, its files and matches?")) deleteMut.mutate(selected.id); }} aria-label="Delete selected case" className="text-xs border border-[var(--border)] rounded-lg px-3 py-2 text-[var(--dim)]">Delete case</button>
                    </div>
                  </div>
                  {matches.length > 0 && <p className="text-[11px] text-[var(--dim)] mt-3">Patient summary is ready — plain-language findings, options to discuss, and questions for your oncologist. Use Print in the summary for a clean PDF.</p>}
                </div>

                {/* Patient Summary Modal / Panel */}
                {showSummary && (
                  <section id="patient-summary-print" className="bg-[var(--surface)] border-2 border-teal-600 rounded-2xl overflow-hidden" aria-label="Patient summary">
                    <div className="px-4 md:px-5 py-3 bg-teal-700 text-white flex flex-wrap items-center justify-between gap-2 no-print">
                      <span className="font-bold text-sm">📄 Patient Summary — Export</span>
                      <div className="flex gap-2">
                        <button onClick={copySummary} aria-label="Copy patient summary" className="text-xs bg-white/15 border border-white/25 rounded-lg px-2.5 py-1.5">{summaryCopied ? "✓ Copied" : "Copy"}</button>
                        <button onClick={() => downloadSummary("txt")} aria-label="Download summary text file" className="text-xs bg-white text-teal-800 font-semibold rounded-lg px-2.5 py-1.5">Download .txt</button>
                        <button onClick={() => downloadSummary("html")} aria-label="Download summary HTML file" className="text-xs bg-white text-teal-800 font-semibold rounded-lg px-2.5 py-1.5">Download .html</button>
                        <button onClick={() => window.print()} aria-label="Print patient summary" className="text-xs bg-[#0B1220] text-white rounded-lg px-2.5 py-1.5">Print / PDF</button>
                        <button onClick={() => setShowSummary(false)} aria-label="Close patient summary" className="text-xs bg-white/15 border border-white/25 rounded-lg px-2.5 py-1.5">Close ×</button>
                      </div>
                    </div>
                    <div className="p-4 md:p-6">
                      <h3 className="text-xl font-bold">Your biomarker results, in plain language</h3>
                      <p className="text-xs font-mono2 text-[var(--dim)] mt-1">Prepared {new Date().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })} · For {selected.label} · {selected.cancerType} — {selected.stage}</p>
                      <div className="mt-4 rounded-xl bg-[var(--surface2)] border border-[var(--border)] p-4 grid grid-cols-2 md:grid-cols-4 gap-3 text-center">
                        <div><div className="font-bold text-lg">{uploads.length}</div><div className="text-[10px] uppercase tracking-widest text-[var(--dim)]">Files reviewed</div></div>
                        <div><div className="font-bold text-lg">{matches.length}</div><div className="text-[10px] uppercase tracking-widest text-[var(--dim)]">Findings</div></div>
                        <div><div className="font-bold text-lg">{matches.filter(m => m.classification === "Potential match").length}</div><div className="text-[10px] uppercase tracking-widest text-[var(--dim)]">Potential matches</div></div>
                        <div><div className="font-bold text-lg">{matches.reduce((a, m) => a + m.trialCount, 0)}</div><div className="text-[10px] uppercase tracking-widest text-[var(--dim)]">Trial records</div></div>
                      </div>

                      {matches.length === 0 ? (
                        <div className="mt-4 rounded-xl border border-dashed border-[var(--border)] p-4 text-center">
                          <p className="font-semibold text-sm">No findings yet</p>
                          <p className="text-xs text-[var(--dim)] mt-1">Upload files and run the AI match below — your summary will populate automatically. You can still download the template with questions for your oncologist.</p>
                        </div>
                      ) : (
                        <ol className="mt-4 space-y-3">
                          {matches.map((m, i) => (
                            <li key={m.id} className="rounded-xl border border-[var(--border)] p-3.5">
                              <div className="flex flex-wrap justify-between gap-2">
                                <span className="font-bold text-sm">{i + 1}. {m.gene} {m.variant} <span className="font-normal text-[var(--dim)]">— {m.classification}</span></span>
                                <span className="text-[11px] font-mono2 bg-teal-100 dark:bg-teal-900/40 text-teal-800 dark:text-teal-200 px-2 py-0.5 rounded-full">{m.confidence}% match · Score {m.evidenceLevel}</span>
                              </div>
                              <p className="text-[13px] mt-1.5 leading-relaxed">{plainExplanation(m.gene, m.therapy)}</p>
                              <p className="text-[13px] mt-1"><strong>Option to discuss:</strong> {m.therapy} <span className="text-[var(--dim)]">· {m.trialCount} trial record found{m.vaf > 0 ? ` · VAF ${m.vaf.toFixed(1)}%` : ""}</span></p>
                            </li>
                          ))}
                        </ol>
                      )}

                      <div className="mt-4 grid md:grid-cols-2 gap-3">
                        <div className="rounded-xl bg-[var(--surface2)] border border-[var(--border)] p-4">
                          <h4 className="font-bold text-sm">What this means</h4>
                          <p className="text-[13px] text-[var(--dim)] leading-relaxed mt-1">Biomarkers are clues in the cancer that can point to treatments most likely to help. A match doesn't guarantee success — your oncologist weighs your health, prior treatments, and preferences.</p>
                        </div>
                        <div className="rounded-xl bg-[var(--surface2)] border border-[var(--border)] p-4">
                          <h4 className="font-bold text-sm">Questions to ask your oncologist</h4>
                          <ol className="text-[13px] text-[var(--dim)] leading-relaxed mt-1 list-decimal list-inside space-y-0.5">
                            <li>Which finding is most actionable right now?</li>
                            <li>Should inherited testing be confirmed?</li>
                            <li>Am I eligible for any of these trials?</li>
                            <li>Benefits, side effects & alternatives?</li>
                          </ol>
                        </div>
                      </div>
                      <pre className="mt-4 whitespace-pre-wrap text-[11px] font-mono2 bg-[var(--surface2)] border border-[var(--border)] rounded-xl p-3 max-h-48 overflow-auto no-print" aria-label="Plain text summary preview">{buildSummaryText()}</pre>
                      <p className="text-[11px] text-[var(--dim)] mt-3">Research prototype — not medical advice. Review with a qualified oncologist / molecular tumor board.</p>
                    </div>
                  </section>
                )}

                {/* Upload zone */}
                <section className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl overflow-hidden no-print">
                  <div className="px-4 md:px-5 pt-4 pb-3 flex items-center justify-between">
                    <h3 className="font-bold">Upload Research</h3>
                    <span className="text-[11px] font-mono2 text-[var(--dim)]">TXT · CSV · TSV · JSON · 5 MB MAX</span>
                  </div>
                  <div
                    onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
                    onDragLeave={() => setIsDragging(false)}
                    onDrop={e => { e.preventDefault(); setIsDragging(false); handleFiles(e.dataTransfer.files); }}
                    className={`mx-4 md:mx-5 rounded-2xl border-2 border-dashed p-6 text-center transition ${isDragging ? "border-teal-600 bg-teal-50 dark:bg-teal-950/30" : "border-[var(--border)] bg-[var(--surface2)]"}`}
                  >
                    <div className="mx-auto w-12 h-12 rounded-full bg-[#0B1220] text-white flex items-center justify-center text-xl">⬆</div>
                    <p className="font-semibold mt-3">Drop research files here</p>
                    <p className="text-xs text-[var(--dim)] mt-1 max-w-md mx-auto">Upload a plain biomarker-symbol list. The file is sent to the Worker for validation and matching; the original bytes are not stored — D1 retains only the file metadata and extracted symbols.</p>
                    <div className="flex flex-wrap justify-center gap-2 mt-4">
                      <button onClick={() => fileRef.current?.click()} aria-label="Browse biomarker lists to upload" className="bg-teal-700 text-white text-sm font-semibold px-4 py-2.5 rounded-full">Browse biomarker lists</button>
                      <button onClick={() => { void addSampleBiomarkerList(); }} aria-label="Add a sample biomarker list" className="bg-white dark:bg-transparent border border-[var(--border)] text-sm font-semibold px-4 py-2.5 rounded-full">+ Add sample biomarker list</button>
                    </div>
                    <input ref={fileRef} type="file" multiple accept=".txt,.csv,.tsv,.json" onChange={e => { void handleFiles(e.target.files); e.currentTarget.value = ""; }} className="hidden" aria-label="File input" />
                  </div>

                  <div className="px-4 md:px-5 py-4">
                    {uploads.length === 0 ? (
                      <p className="text-sm text-[var(--dim)] text-center py-2">No files yet — add the sample biomarker list or browse for a supported list.</p>
                    ) : (
                      <ul className="divide-y divide-[var(--border)]">
                        {uploads.map(u => (
                          <li key={u.id} className="py-2.5 flex items-center gap-3">
                            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-teal-100 dark:bg-teal-900/40 text-teal-800 dark:text-teal-200 text-[10px] font-mono2 font-bold">{u.fileKind.slice(0, 3).toUpperCase()}</span>
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium truncate">{u.fileName}</p>
                              <p className="text-[11px] text-[var(--dim)] font-mono2">{u.fileKind} · {(u.sizeKb / 1024).toFixed(2)} MB · {new Date(u.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</p><p className="text-[11px] font-mono2 text-teal-700 dark:text-teal-300">{u.biomarkers.join(", ")}</p>
                            </div>
                            <span className="text-[10px] font-mono2 px-2 py-1 rounded-full bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-200">ANALYZED ✓</span>
                            <button onClick={() => deleteUploadMut.mutate(u.id)} aria-label={`Remove ${u.fileName}`} className="text-[var(--dim)] px-1 text-lg leading-none">×</button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  <div className="px-4 md:px-5 pb-5">
                    <button onClick={handleRun} disabled={runMut.isPending || pipelineStep >= 0} aria-label="Run AI biomarker match" className="w-full bg-teal-700 hover:bg-teal-800 text-white font-bold py-3.5 rounded-xl text-[15px] disabled:opacity-60 flex items-center justify-center gap-2">
                      {pipelineStep >= 0 && pipelineStep < 4 ? `⟳ ${pipeline[pipelineStep]?.label} — analyzing…` : pipelineStep === 4 ? "✓ Match Complete — Results Below" : matches.length ? "↻ Re-run AI Biomarker Match" : "✦ Run AI Biomarker Match"}
                    </button>
                    {(addUploadMut.isError || runMut.isError) && <p className="text-xs text-rose-700 text-center mt-2" role="alert">{(addUploadMut.error || runMut.error) instanceof Error ? (addUploadMut.error || runMut.error)!.message : "The match request failed."}</p>}
                    <p className="text-[11px] text-center text-[var(--dim)] mt-2">Lenhard engine: uploaded symbols are matched against D1 trial criteria for this {selected.cancerType} case. Not medical advice.</p>
                  </div>
                </section>

                {/* Results */}
                {matches.length > 0 && (
                  <section>
                    <div className="flex flex-wrap items-end justify-between gap-2 px-1 mb-3">
                      <div>
                        <h3 className="font-bold text-lg leading-none">Trial Matches</h3>
                        <p className="text-xs text-[var(--dim)] mt-1">{matches.length} D1 trial records · {matches.filter(m => m.classification === "Potential match").length} potential matches · Sorted by match score</p>
                      </div>
                      <div className="flex gap-2">
                        <button onClick={() => setShowSummary(true)} aria-label="Export patient summary from results" className="text-[11px] font-semibold bg-teal-700 text-white rounded-full px-3 py-1.5">📄 Export Summary</button>
                        <span className="hidden md:inline text-[11px] font-mono2 bg-[var(--surface)] border border-[var(--border)] rounded-full px-2.5 py-1">FOR TUMOR BOARD</span>
                      </div>
                    </div>
                    <div className="grid md:grid-cols-2 gap-3">
                      {matches.map(m => (
                        <article key={m.id} className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-4 flex flex-col">
                          <div className="flex items-start justify-between gap-2">
                            <div>
                              <div className="flex items-baseline gap-2 flex-wrap">
                                <span className="font-mono2 font-bold text-[22px] leading-none tracking-tight">{m.gene}</span>
                                <span className="font-mono2 text-sm font-semibold text-teal-700 dark:text-teal-300">{m.variant}</span>
                              </div>
                              <p className="text-xs text-[var(--dim)] mt-1 font-mono2">{m.alteration}{m.vaf > 0 ? ` · VAF ${m.vaf.toFixed(1)}%` : ""}</p>
                            </div>
                            <span className={`shrink-0 text-[10px] font-bold px-2 py-1 rounded-full ${classBadge(m.classification)}`}>{m.classification.toUpperCase()}</span>
                          </div>
                          <div className="mt-3">
                            <div className="flex justify-between text-[11px] font-mono2"><span className="text-[var(--dim)]">MATCH SCORE</span><span className="font-bold">{m.confidence}%</span></div>
                            <div className="h-2 rounded-full bg-[var(--surface2)] border border-[var(--border)] mt-1 overflow-hidden"><div className={`h-full rounded-full ${confidenceColor(m.confidence)}`} style={{ width: `${m.confidence}%` }} /></div>
                          </div>
                          <p className="text-[13px] leading-relaxed mt-3 text-[var(--text)]/90 flex-1">{m.rationale}</p>
                          <p className="text-[12px] leading-relaxed mt-2 bg-[var(--surface2)] border border-[var(--border)] rounded-lg px-2.5 py-2"><span className="font-semibold">For the patient: </span>{plainExplanation(m.gene, m.therapy)}</p>
                          <div className="mt-3 pt-3 border-t border-[var(--border)] flex flex-wrap gap-2">
                            <span className="inline-flex items-center gap-1 bg-[#0B1220] text-white text-xs font-semibold px-2.5 py-1.5 rounded-lg">🧪 Trial: {m.therapy}</span>
                            <span className="inline-flex items-center text-xs font-mono2 px-2 py-1.5 rounded-lg bg-[var(--surface2)] border border-[var(--border)]">{m.evidenceLevel}</span>
                            <span className="inline-flex items-center text-xs font-mono2 px-2 py-1.5 rounded-lg bg-[var(--surface2)] border border-[var(--border)]">🧪 {m.trialCount} trial record</span>
                          </div>
                        </article>
                      ))}
                    </div>

                    <div className="mt-4 bg-[var(--surface)] border border-[var(--border)] rounded-2xl overflow-hidden">
                      <div className="px-4 py-3 border-b border-[var(--border)] flex flex-wrap justify-between gap-2"><span className="font-bold text-sm">Trial Ranking — At a Glance</span><div className="flex gap-2"><button onClick={() => downloadSummary("html")} aria-label="Download therapy ranking summary HTML" className="text-[11px] font-mono2 border border-[var(--border)] rounded-full px-2.5 py-1">⬇ EXPORT .HTML</button><span className="text-[11px] font-mono2 text-[var(--dim)] self-center">MOCKUP</span></div></div>
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm min-w-[520px]">
                          <thead><tr className="text-left text-[11px] uppercase tracking-wider text-[var(--dim)] border-b border-[var(--border)]"><th className="px-4 py-2 font-semibold">Matched Biomarkers</th><th className="px-4 py-2 font-semibold">Trial</th><th className="px-4 py-2 font-semibold">Match Score</th><th className="px-4 py-2 font-semibold text-right">Records</th></tr></thead>
                          <tbody>
                            {matches.map(m => (
                              <tr key={m.id} className="border-b border-[var(--border)] last:border-0">
                                <td className="px-4 py-2.5 font-mono2 font-semibold">{m.gene} <span className="font-normal text-[var(--dim)]">{m.variant}</span></td>
                                <td className="px-4 py-2.5">{m.therapy}</td>
                                <td className="px-4 py-2.5 font-mono2 text-xs">{m.evidenceLevel}</td>
                                <td className="px-4 py-2.5 text-right font-mono2">{m.trialCount}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <p className="px-4 py-3 text-[11px] text-[var(--dim)] leading-relaxed bg-[var(--surface2)]">These results are computed from the uploaded symbols and the trial criteria currently stored in D1. They do not establish eligibility and require clinician review before any treatment decision.</p>
                    </div>
                  </section>
                )}

                {matches.length === 0 && uploads.length > 0 && (
                  <div className="bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800 rounded-2xl p-4 flex gap-3">
                    <span className="text-xl">👆</span>
                    <div><p className="font-semibold text-sm">Files ready — now run the match</p><p className="text-xs text-[var(--dim)] mt-0.5">Hit “Run AI Biomarker Match” above to extract variants from your {uploads.length} file{uploads.length > 1 ? "s" : ""} and rank therapies.</p></div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        {/* Coverage + explainer */}
        <div className="mt-6 bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-4 md:p-5 no-print">
          <h3 className="font-bold">Cancer Type Coverage — Intake Libraries</h3>
          <p className="text-[13px] text-[var(--dim)] mt-1">These 16 categories plus Rare organize clinician intake. Trial results always come from the current D1 catalog, so the interface does not invent a separate result set for a category with no matching D1 trial.</p>
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3 mt-3">
            {Object.entries(CANCER_GROUPS).map(([group, types]) => (
              <div key={group} className="rounded-xl bg-[var(--surface2)] border border-[var(--border)] p-3">
                <p className="text-[11px] font-mono2 tracking-widest uppercase text-teal-700 dark:text-teal-300 font-bold">{group}</p>
                <ul className="mt-2 space-y-1">{types.map(t => <li key={t}><button onClick={() => { setCancerType(t); setShowForm(true); window.scrollTo({ top: 0, behavior: "smooth" }); }} aria-label={`Start a case for ${t}`} className="text-[13px] hover:underline text-left">• {t}</button></li>)}</ul>
              </div>
            ))}
          </div>
        </div>

        <div className="grid md:grid-cols-3 gap-3 mt-4 no-print">
          {[
            { t: "1 · Intake & Upload", d: "Clinician creates a de-identified case and uploads a supported biomarker list for that case." },
            { t: "2 · AI Extraction", d: "The Worker validates the list, rejects free text and unknown symbols, and stores only the extracted biomarker symbols with the file metadata." },
            { t: "3 · Match, Rank & Summarize", d: "Each uploaded symbol is compared with D1 trial criteria, ranked by the Lenhard match score, then included in a patient summary you can copy, download, or print." },
          ].map(c => (
            <div key={c.t} className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-4">
              <h4 className="font-bold text-sm">{c.t}</h4>
              <p className="text-[13px] text-[var(--dim)] leading-relaxed mt-1.5">{c.d}</p>
            </div>
          ))}
        </div>
        <p className="text-center text-[11px] text-[var(--dim)] mt-6 font-mono2">ONCOLOGY BIOMARKER MATCHER — CLOUDFLARE WORKER + D1 · {CANCER_TYPES.length - 1} CANCER TYPES · CLINICAL DARK AVAILABLE · LIVE API DATA · RESEARCH PROTOTYPE · NOT FOR CLINICAL USE</p>
      </main>
    </div>
  );
}
