import { integer, sqliteTable, text, real } from "drizzle-orm/sqlite-core";

export const cases = sqliteTable("cases", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  label: text("label").notNull(),
  cancerType: text("cancer_type").notNull(),
  stage: text("stage").notNull().default("Stage IV"),
  histology: text("histology").notNull().default(""),
  sampleType: text("sample_type").notNull().default("Tissue NGS"),
  priorTherapy: text("prior_therapy").notNull().default(""),
  status: text("status", { enum: ["intake", "processing", "matched"] }).notNull().default("intake"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});

export const uploads = sqliteTable("uploads", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  caseId: integer("case_id").notNull(),
  fileName: text("file_name").notNull(),
  fileKind: text("file_kind").notNull().default("Research PDF"),
  sizeKb: integer("size_kb").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});

export const matches = sqliteTable("matches", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  caseId: integer("case_id").notNull(),
  gene: text("gene").notNull(),
  variant: text("variant").notNull(),
  alteration: text("alteration").notNull(),
  vaf: real("vaf").notNull().default(0),
  classification: text("classification").notNull(),
  therapy: text("therapy").notNull(),
  evidenceLevel: text("evidence_level").notNull(),
  trialCount: integer("trial_count").notNull().default(0),
  confidence: integer("confidence").notNull().default(80),
  rationale: text("rationale").notNull().default(""),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});
