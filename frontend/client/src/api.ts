// Browser client for the Cloudflare Worker API. This replaces the original
// hosted-runtime @hatch/space-sdk RPC client; no part of that SDK is needed
// by the standalone production build.

export type Role = "doctor" | "reviewer" | "admin";

export interface PlatformUser {
  id: string;
  name: string;
  email: string;
  npi: string;
  licenseNumber: string;
  licenseState: string;
  role: Role;
  status: "pending" | "active" | "suspended";
  npiVerification: string;
  npiVerificationDetail?: string | null;
  mfaConfirmedAt?: string | null;
  mfaEnrolled: boolean;
  approvedBy?: string | null;
  approvedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CaseRow {
  id: number;
  label: string;
  cancerType: string;
  stage: string;
  histology: string;
  sampleType: string;
  priorTherapy: string;
  status: string;
  created_at: string;
  uploadCount: number;
  matchCount: number;
}

export interface UploadRow {
  id: number;
  fileName: string;
  fileKind: string;
  sizeKb: number;
  biomarkers: string[];
  created_at: string;
}

export interface MatchRow {
  id: number;
  gene: string;
  variant: string;
  alteration: string;
  vaf: number;
  classification: string;
  therapy: string;
  evidenceLevel: string;
  trialCount: number;
  confidence: number;
  rationale: string;
  status: string;
}

export interface CaseDetail {
  uploads: UploadRow[];
  matches: MatchRow[];
}

export interface Submission {
  id: string;
  title: string;
  summary: string;
  biomarkers: string[];
  cancerType: string;
  sourceUrl?: string | null;
  status: "pending_review" | "approved" | "rejected";
  version: number;
  reviewNote?: string | null;
  createdAt: string;
  updatedAt: string;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...init,
    headers: init.body instanceof FormData ? init.headers : { "Content-Type": "application/json", ...init.headers },
  });
  const data = await response.json().catch(() => ({})) as { error?: string; code?: string };
  if (!response.ok) {
    const error = new Error(data.error || `Request failed (${response.status})`) as Error & { code?: string; status?: number };
    error.code = data.code;
    error.status = response.status;
    throw error;
  }
  return data as T;
}

export const api = {
  me: () => request<{ user: PlatformUser }>("/api/auth/me"),
  login: (email: string, password: string, totpCode: string) =>
    request<{ user: PlatformUser }>("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password, totpCode }) }),
  logout: () => request<{ ok: true }>("/api/auth/logout", { method: "POST", body: "{}" }),
  register: (input: Record<string, string>) =>
    request<PlatformUser>("/api/auth/register", { method: "POST", body: JSON.stringify(input) }),
  beginMfa: (email: string, password: string) =>
    request<{ secret: string; otpauthUri: string }>("/api/auth/mfa/enroll", { method: "POST", body: JSON.stringify({ email, password }) }),
  confirmMfa: (email: string, password: string, code: string) =>
    request<PlatformUser>("/api/auth/mfa/confirm", { method: "POST", body: JSON.stringify({ email, password, code }) }),
  createInvite: (email: string, role: Role) =>
    request<{ inviteId: string; token: string; registrationPath: string; expiresAt: string }>("/api/auth/invites", { method: "POST", body: JSON.stringify({ email: email || undefined, role }) }),
  listUsers: () => request<PlatformUser[]>("/api/auth/users"),
  approveUser: (id: string) => request<PlatformUser>(`/api/auth/users/${encodeURIComponent(id)}/approve`, { method: "POST", body: "{}" }),
  suspendUser: (id: string) => request<PlatformUser>(`/api/auth/users/${encodeURIComponent(id)}/suspend`, { method: "POST", body: "{}" }),

  listCases: ({ limit }: { limit: number }) =>
    request<{ cases: CaseRow[]; stats: { totalCases: number; totalUploads: number; totalMatches: number; actionable: number } }>(`/api/cases?limit=${limit}`),
  createCase: (input: { label: string; cancerType: string; stage: string; histology: string; sampleType: string; priorTherapy: string }) =>
    request<{ id: number }>("/api/cases", { method: "POST", body: JSON.stringify(input) }),
  deleteCase: ({ id }: { id: number }) => request<{ ok: true }>(`/api/cases/${id}`, { method: "DELETE" }),
  getCaseDetail: ({ caseId }: { caseId: number }) => request<CaseDetail>(`/api/cases/${caseId}/detail`),
  uploadResearch: async (caseId: number, file: File) => {
    const form = new FormData();
    form.set("research", file);
    return request<{ id: number; biomarkers: string[] }>(`/api/cases/${caseId}/uploads`, { method: "POST", body: form });
  },
  deleteUpload: ({ id }: { id: number }) => request<{ ok: true }>(`/api/uploads/${id}`, { method: "DELETE" }),
  runMatch: ({ caseId }: { caseId: number }) => request<{ count: number; ok: true }>(`/api/cases/${caseId}/run-match`, { method: "POST", body: "{}" }),

  listSubmissions: () => request<Submission[]>("/api/submissions"),
  createSubmission: (input: { title: string; summary: string; biomarkers: string[]; cancerType: string; sourceUrl?: string }) =>
    request<Submission>("/api/submissions", { method: "POST", body: JSON.stringify(input) }),
  listReviewQueue: () => request<Submission[]>("/api/review-queue"),
  approveSubmission: (id: string, note?: string) =>
    request<Submission>(`/api/review-queue/${encodeURIComponent(id)}/approve`, { method: "POST", body: JSON.stringify({ note }) }),
  rejectSubmission: (id: string, note: string) =>
    request<Submission>(`/api/review-queue/${encodeURIComponent(id)}/reject`, { method: "POST", body: JSON.stringify({ note }) }),
};
