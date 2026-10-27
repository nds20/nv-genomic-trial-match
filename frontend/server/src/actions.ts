import { defineAction, z, type ActionsModule } from "@hatch/space-sdk";
import { desc, eq } from "drizzle-orm";
import * as schema from "./schema";

type MatchTemplate = {
  gene: string; variant: string; alteration: string; vaf: number; classification: string; therapy: string; evidenceLevel: string; trialCount: number; confidence: number; rationale: string;
};

const MATCH_LIBRARY: Record<string, MatchTemplate[]> = {
  "Non-Small Cell Lung Cancer": [
    { gene: "EGFR", variant: "L858R", alteration: "Missense · Exon 21", vaf: 34.2, classification: "Pathogenic", therapy: "Osimertinib", evidenceLevel: "Level 1", trialCount: 14, confidence: 97, rationale: "Sensitizing EGFR mutation with strong response data to 3rd-gen TKI in first-line NSCLC." },
    { gene: "KRAS", variant: "G12C", alteration: "Missense · Exon 2", vaf: 28.7, classification: "Pathogenic", therapy: "Sotorasib / Adagrasib", evidenceLevel: "Level 1", trialCount: 9, confidence: 92, rationale: "KRAS G12C is now druggable — covalent inhibitors show durable responses post-chemo-IO." },
    { gene: "ALK", variant: "EML4-ALK Fusion", alteration: "Fusion · Exon 20", vaf: 18.4, classification: "Pathogenic", therapy: "Alectinib", evidenceLevel: "Level 1", trialCount: 11, confidence: 94, rationale: "ALK rearrangement predicts marked sensitivity to ALK TKIs; CNS-penetrant options preferred." },
    { gene: "TP53", variant: "R273H", alteration: "Missense · Exon 8", vaf: 41.1, classification: "Pathogenic", therapy: "Investigational — TP53 reactivator trials", evidenceLevel: "Level 3", trialCount: 6, confidence: 78, rationale: "Co-mutation associated with poorer TKI durability; trial referral recommended." },
    { gene: "PD-L1", variant: "TPS 65%", alteration: "IHC Expression", vaf: 0, classification: "Predictive", therapy: "Pembrolizumab", evidenceLevel: "Level 1", trialCount: 18, confidence: 89, rationale: "High PD-L1 expression supports PD-1 blockade, sequenced after targeted therapy." },
  ],
  "Breast Cancer": [
    { gene: "BRCA1", variant: "c.68_69delAG", alteration: "Frameshift · Germline", vaf: 49.8, classification: "Pathogenic", therapy: "Olaparib", evidenceLevel: "Level 1", trialCount: 12, confidence: 96, rationale: "Germline BRCA1 loss creates homologous recombination deficiency — PARP inhibitor sensitive." },
    { gene: "PIK3CA", variant: "H1047R", alteration: "Missense · Exon 20", vaf: 31.5, classification: "Pathogenic", therapy: "Alpelisib + Fulvestrant", evidenceLevel: "Level 1", trialCount: 8, confidence: 91, rationale: "PI3Kα hotspot mutation in HR+/HER2- disease predicts benefit from PI3K inhibition." },
    { gene: "ERBB2 (HER2)", variant: "Amplification", alteration: "Copy Number Gain", vaf: 0, classification: "Pathogenic", therapy: "Trastuzumab Deruxtecan", evidenceLevel: "Level 1", trialCount: 15, confidence: 95, rationale: "HER2 amplification / HER2-low reclassification opens ADC therapy with strong intracranial activity." },
    { gene: "ESR1", variant: "Y537S", alteration: "Missense · LBD", vaf: 12.3, classification: "Pathogenic", therapy: "Elacestrant", evidenceLevel: "Level 2", trialCount: 7, confidence: 84, rationale: "Acquired ESR1 mutation after aromatase inhibitor — oral SERD indicated." },
  ],
  "Colorectal Cancer": [
    { gene: "KRAS", variant: "G12D", alteration: "Missense · Exon 2", vaf: 36.9, classification: "Pathogenic", therapy: "Investigational KRAS G12D inhibitor", evidenceLevel: "Level 3", trialCount: 10, confidence: 82, rationale: "G12D is the most common CRC KRAS allele; pan-RAS and G12D-specific trials enrolling." },
    { gene: "BRAF", variant: "V600E", alteration: "Missense · Exon 15", vaf: 29.4, classification: "Pathogenic", therapy: "Encorafenib + Cetuximab", evidenceLevel: "Level 1", trialCount: 9, confidence: 93, rationale: "BRAF V600E CRC requires combined BRAF + EGFR blockade per BEACON regimen." },
    { gene: "MSI / MMR", variant: "MSI-High · MLH1 loss", alteration: "Microsatellite Instability", vaf: 0, classification: "Predictive", therapy: "Pembrolizumab", evidenceLevel: "Level 1", trialCount: 13, confidence: 95, rationale: "dMMR/MSI-H predicts exceptional response to PD-1 blockade in first line." },
    { gene: "HER2", variant: "Amplification 3+", alteration: "Copy Number Gain", vaf: 0, classification: "Pathogenic", therapy: "Trastuzumab + Tucatinib", evidenceLevel: "Level 2", trialCount: 6, confidence: 86, rationale: "HER2-amplified RAS wild-type CRC — dual HER2 blockade is an emerging standard." },
  ],
  "Pancreatic Cancer": [
    { gene: "BRCA2", variant: "c.5946delT", alteration: "Frameshift · Germline", vaf: 47.2, classification: "Pathogenic", therapy: "Olaparib maintenance", evidenceLevel: "Level 1", trialCount: 8, confidence: 94, rationale: "Germline BRCA2 PDAC is platinum-sensitive; PARP maintenance prolongs PFS after platinum." },
    { gene: "KRAS", variant: "G12D", alteration: "Missense · Exon 2", vaf: 44.6, classification: "Pathogenic", therapy: "KRAS G12D trial / Pan-RAS", evidenceLevel: "Level 3", trialCount: 11, confidence: 81, rationale: "Near-universal in PDAC; G12D-selective inhibitors in early-phase trials." },
    { gene: "PALB2", variant: "c.3113G>A", alteration: "Nonsense", vaf: 38.1, classification: "Pathogenic", therapy: "Platinum + PARP trial", evidenceLevel: "Level 2", trialCount: 5, confidence: 85, rationale: "PALB2 loss phenocopies BRCA — homologous recombination deficiency signature present." },
  ],
  "Melanoma": [
    { gene: "BRAF", variant: "V600E", alteration: "Missense · Exon 15", vaf: 52.3, classification: "Pathogenic", therapy: "Dabrafenib + Trametinib", evidenceLevel: "Level 1", trialCount: 16, confidence: 97, rationale: "Classic BRAF/MEK target; sequencing vs. immunotherapy decided by disease tempo and LDH." },
    { gene: "NRAS", variant: "Q61R", alteration: "Missense · Exon 3", vaf: 39.8, classification: "Pathogenic", therapy: "Binimetinib / IO combination trial", evidenceLevel: "Level 3", trialCount: 7, confidence: 79, rationale: "NRAS-mutant melanoma — MEK inhibition and IO combos under investigation." },
    { gene: "TMB", variant: "18.4 mut/Mb — High", alteration: "Tumor Mutational Burden", vaf: 0, classification: "Predictive", therapy: "Nivolumab + Ipilimumab", evidenceLevel: "Level 1", trialCount: 14, confidence: 90, rationale: "High TMB supports dual checkpoint blockade with durable benefit in melanoma." },
  ],
  "Prostate Cancer": [
    { gene: "BRCA2", variant: "c.8537_8540del", alteration: "Frameshift · Germline + Somatic", vaf: 46.1, classification: "Pathogenic", therapy: "Olaparib / Rucaparib", evidenceLevel: "Level 1", trialCount: 13, confidence: 95, rationale: "HRR-deficient mCRPC — PARP inhibition improves radiographic PFS and OS in BRCA2-altered disease." },
    { gene: "AR", variant: "AR-V7 Splice Variant", alteration: "Splice · Resistance", vaf: 0, classification: "Predictive", therapy: "Taxane chemotherapy preferred", evidenceLevel: "Level 2", trialCount: 6, confidence: 87, rationale: "AR-V7 in CTCs predicts resistance to abiraterone/enzalutamide — taxane sequencing favored." },
    { gene: "PTEN", variant: "Loss · 10q23 deletion", alteration: "Copy Number Loss", vaf: 0, classification: "Pathogenic", therapy: "Ipatasertib + Abiraterone trial", evidenceLevel: "Level 2", trialCount: 8, confidence: 85, rationale: "PTEN loss activates AKT pathway; AKT inhibitor combos show benefit in PTEN-loss mCRPC." },
    { gene: "MSI / MMR", variant: "MSI-High · MSH2 loss", alteration: "Microsatellite Instability", vaf: 0, classification: "Predictive", therapy: "Pembrolizumab", evidenceLevel: "Level 1", trialCount: 7, confidence: 90, rationale: "Tumor-agnostic approval for dMMR/MSI-H solid tumors including prostate." },
    { gene: "PSMA", variant: "High expression · PET avid", alteration: "IHC / PET Imaging", vaf: 0, classification: "Predictive", therapy: "177Lu-PSMA-617 (Pluvicto)", evidenceLevel: "Level 1", trialCount: 10, confidence: 93, rationale: "PSMA-positive mCRPC post-ARPI and taxane — radioligand therapy improves OS." },
  ],
  "Ovarian Cancer": [
    { gene: "BRCA1", variant: "c.185delAG", alteration: "Frameshift · Germline", vaf: 51.2, classification: "Pathogenic", therapy: "Niraparib maintenance", evidenceLevel: "Level 1", trialCount: 14, confidence: 96, rationale: "Germline BRCA1 high-grade serous — profound HRD, PARP maintenance after platinum response." },
    { gene: "HRD", variant: "Genomic Scar Score 68 — Positive", alteration: "HRD Signature", vaf: 0, classification: "Predictive", therapy: "Olaparib + Bevacizumab", evidenceLevel: "Level 1", trialCount: 11, confidence: 91, rationale: "HRD-positive (LOH/TAI/LST) predicts PARP + VEGF combo benefit regardless of BRCA status." },
    { gene: "FOLR1 (FRα)", variant: "75% TPS — High", alteration: "IHC Expression", vaf: 0, classification: "Predictive", therapy: "Mirvetuximab Soravtansine", evidenceLevel: "Level 1", trialCount: 9, confidence: 89, rationale: "FRα-high platinum-resistant ovarian cancer — ADC with proven OS benefit." },
    { gene: "CCNE1", variant: "Amplification", alteration: "Copy Number Gain", vaf: 0, classification: "Pathogenic", therapy: "WEE1 / PKMYT1 inhibitor trial", evidenceLevel: "Level 3", trialCount: 5, confidence: 78, rationale: "CCNE1-amplified, often BRCA-wt and platinum-resistant — cell-cycle checkpoint trials prioritized." },
  ],
  "Gastric Cancer": [
    { gene: "ERBB2 (HER2)", variant: "IHC 3+ / ISH+", alteration: "Amplification", vaf: 0, classification: "Pathogenic", therapy: "Trastuzumab + Chemo / T-DXd in 2L", evidenceLevel: "Level 1", trialCount: 12, confidence: 94, rationale: "HER2-positive gastric/GEJ — HER2 blockade is first-line standard; T-DXd after trastuzumab." },
    { gene: "CLDN18.2", variant: "≥75% IHC 2+/3+ — Positive", alteration: "IHC Expression", vaf: 0, classification: "Predictive", therapy: "Zolbetuximab + mFOLFOX6", evidenceLevel: "Level 1", trialCount: 8, confidence: 90, rationale: "Claudin 18.2-positive, HER2-negative gastric — first targeted antibody in this subtype." },
    { gene: "PD-L1", variant: "CPS 12", alteration: "IHC · Combined Positive Score", vaf: 0, classification: "Predictive", therapy: "Nivolumab + Chemotherapy", evidenceLevel: "Level 1", trialCount: 15, confidence: 88, rationale: "PD-L1 CPS ≥5 predicts chemo-IO benefit in advanced gastric/GEJ adenocarcinoma." },
    { gene: "MSI / MMR", variant: "MSI-High · MLH1 methylation", alteration: "Microsatellite Instability", vaf: 0, classification: "Predictive", therapy: "Pembrolizumab", evidenceLevel: "Level 1", trialCount: 9, confidence: 92, rationale: "dMMR gastric cancer — exceptional IO sensitivity, consider IO-first strategy." },
  ],
  "Bladder / Urothelial Cancer": [
    { gene: "FGFR3", variant: "S249C", alteration: "Missense · Exon 7", vaf: 33.7, classification: "Pathogenic", therapy: "Erdafitinib", evidenceLevel: "Level 1", trialCount: 10, confidence: 93, rationale: "FGFR3-altered urothelial carcinoma post-IO — FGFR inhibitor improves OS vs chemotherapy." },
    { gene: "ERBB2 (HER2)", variant: "Amplification / IHC 3+", alteration: "Copy Number Gain", vaf: 0, classification: "Pathogenic", therapy: "Trastuzumab Deruxtecan", evidenceLevel: "Level 2", trialCount: 7, confidence: 86, rationale: "HER2-high urothelial — tumor-agnostic T-DXd activity in HER2 IHC 3+ disease." },
    { gene: "NECTIN4", variant: "High expression", alteration: "IHC Expression", vaf: 0, classification: "Predictive", therapy: "Enfortumab Vedotin + Pembrolizumab", evidenceLevel: "Level 1", trialCount: 13, confidence: 95, rationale: "EV + pembro is new first-line standard in locally advanced/metastatic urothelial cancer." },
    { gene: "TP53 + RB1", variant: "Co-loss signature", alteration: "Tumor Suppressor Loss", vaf: 38.4, classification: "Pathogenic", therapy: "Platinum-based chemo sensitivity flag", evidenceLevel: "Level 2", trialCount: 6, confidence: 81, rationale: "TP53/RB1 co-alteration associated with small-cell-like biology and platinum responsiveness." },
  ],
  "Endometrial Cancer": [
    { gene: "MMR", variant: "dMMR · MLH1 loss", alteration: "Mismatch Repair Deficient", vaf: 0, classification: "Predictive", therapy: "Dostarlimab / Pembrolizumab + Chemo", evidenceLevel: "Level 1", trialCount: 14, confidence: 96, rationale: "dMMR endometrial cancer — dramatic benefit from PD-1 blockade added to chemotherapy." },
    { gene: "POLE", variant: "P286R — Ultramutated", alteration: "Missense · Exonuclease Domain", vaf: 27.9, classification: "Pathogenic", therapy: "De-escalation / IO trial", evidenceLevel: "Level 2", trialCount: 5, confidence: 88, rationale: "POLE ultramutated tumors have excellent prognosis and high immunogenicity." },
    { gene: "PIK3CA", variant: "H1047R", alteration: "Missense · Exon 20", vaf: 30.2, classification: "Pathogenic", therapy: "PI3K / mTOR pathway trial", evidenceLevel: "Level 3", trialCount: 8, confidence: 80, rationale: "Very common in endometrioid histology; pathway trials and hormonal combos under study." },
    { gene: "HER2", variant: "IHC 3+", alteration: "Amplification", vaf: 0, classification: "Pathogenic", therapy: "Trastuzumab Deruxtecan", evidenceLevel: "Level 2", trialCount: 6, confidence: 84, rationale: "HER2-positive serous endometrial carcinoma — HER2-directed ADC activity reported." },
  ],
  "Hepatocellular Carcinoma": [
    { gene: "VEGF / Angiogenesis", variant: "High VEGF signature", alteration: "Pathway Activation", vaf: 0, classification: "Predictive", therapy: "Atezolizumab + Bevacizumab", evidenceLevel: "Level 1", trialCount: 12, confidence: 92, rationale: "First-line standard in unresectable HCC with preserved liver function (Child-Pugh A)." },
    { gene: "CTNNB1", variant: "S45P", alteration: "Missense · Exon 3", vaf: 35.6, classification: "Pathogenic", therapy: "IO resistance flag — TKI preferred", evidenceLevel: "Level 2", trialCount: 5, confidence: 82, rationale: "Wnt/β-catenin activation associated with immune-excluded HCC and primary IO resistance." },
    { gene: "TERT", variant: "Promoter C228T", alteration: "Promoter Mutation", vaf: 29.1, classification: "Pathogenic", therapy: "Investigational — telomerase / trial", evidenceLevel: "Level 3", trialCount: 4, confidence: 76, rationale: "Most common HCC alteration; diagnostic support and trial stratification marker." },
    { gene: "AFP", variant: "≥400 ng/mL — Elevated", alteration: "Serum Biomarker", vaf: 0, classification: "Predictive", therapy: "Ramucirumab (REACH-2 population)", evidenceLevel: "Level 1", trialCount: 7, confidence: 87, rationale: "High AFP after sorafenib predicts ramucirumab benefit in second line." },
  ],
  "Renal Cell Carcinoma": [
    { gene: "VHL", variant: "Truncating loss", alteration: "Frameshift · 3p loss", vaf: 43.8, classification: "Pathogenic", therapy: "Belzutifan (HIF-2α inhibitor)", evidenceLevel: "Level 1", trialCount: 9, confidence: 91, rationale: "VHL loss drives HIF signaling in clear-cell RCC — HIF-2α blockade is mechanistically targeted." },
    { gene: "PBRM1", variant: "Loss-of-function", alteration: "Nonsense", vaf: 31.4, classification: "Pathogenic", therapy: "IO + VEGF TKI combination", evidenceLevel: "Level 2", trialCount: 8, confidence: 83, rationale: "PBRM1 loss may enrich for IO responsiveness; standard IO-TKI combos remain backbone." },
    { gene: "MET", variant: "Amplification / Mutation", alteration: "Copy Number Gain", vaf: 0, classification: "Pathogenic", therapy: "Cabozantinib", evidenceLevel: "Level 2", trialCount: 6, confidence: 85, rationale: "MET-driven papillary RCC — cabozantinib has multi-kinase activity including MET/VEGFR." },
  ],
  "Thyroid Cancer": [
    { gene: "BRAF", variant: "V600E", alteration: "Missense · Exon 15", vaf: 48.9, classification: "Pathogenic", therapy: "Dabrafenib + Trametinib (anaplastic)", evidenceLevel: "Level 1", trialCount: 8, confidence: 94, rationale: "BRAF V600E in anaplastic and RAI-refractory differentiated thyroid cancer — BRAF/MEK active." },
    { gene: "RET", variant: "CCDC6-RET Fusion", alteration: "Fusion", vaf: 0, classification: "Pathogenic", therapy: "Selpercatinib", evidenceLevel: "Level 1", trialCount: 10, confidence: 96, rationale: "RET fusion-positive thyroid cancer — highly selective RET inhibition with durable responses." },
    { gene: "NTRK", variant: "ETV6-NTRK3 Fusion", alteration: "Fusion", vaf: 0, classification: "Pathogenic", therapy: "Larotrectinib", evidenceLevel: "Level 1", trialCount: 7, confidence: 95, rationale: "Tumor-agnostic TRK approval — dramatic responses in NTRK fusion thyroid cancers." },
  ],
  "Glioma / Glioblastoma": [
    { gene: "IDH1", variant: "R132H", alteration: "Missense", vaf: 36.2, classification: "Pathogenic", therapy: "Vorasidenib (IDH1/2 inhibitor)", evidenceLevel: "Level 1", trialCount: 11, confidence: 93, rationale: "IDH-mutant grade 2 glioma — vorasidenib delays progression and need for chemoradiation." },
    { gene: "MGMT", variant: "Promoter Methylated", alteration: "Epigenetic Silencing", vaf: 0, classification: "Predictive", therapy: "Temozolomide sensitivity", evidenceLevel: "Level 1", trialCount: 12, confidence: 90, rationale: "MGMT methylation predicts alkylator benefit in glioblastoma, especially in older patients." },
    { gene: "BRAF", variant: "V600E", alteration: "Missense", vaf: 22.5, classification: "Pathogenic", therapy: "Dabrafenib + Trametinib", evidenceLevel: "Level 1", trialCount: 8, confidence: 89, rationale: "Tumor-agnostic BRAF approval includes gliomas; activity in high- and low-grade disease." },
    { gene: "1p/19q", variant: "Codeletion present", alteration: "Chromosomal Loss", vaf: 0, classification: "Predictive", therapy: "PCV + RT chemosensitivity", evidenceLevel: "Level 1", trialCount: 6, confidence: 88, rationale: "Defines oligodendroglioma; predicts benefit from procarbazine/CCNU/vincristine with RT." },
  ],
  "Head and Neck Cancer": [
    { gene: "HPV / p16", variant: "p16+ · HPV16 Positive", alteration: "Viral / IHC", vaf: 0, classification: "Predictive", therapy: "De-escalation trial / Standard CRT", evidenceLevel: "Level 1", trialCount: 13, confidence: 92, rationale: "HPV-positive oropharynx has markedly better prognosis; de-escalation trials ongoing." },
    { gene: "PD-L1", variant: "CPS 18", alteration: "IHC · Combined Positive Score", vaf: 0, classification: "Predictive", therapy: "Pembrolizumab ± Chemotherapy", evidenceLevel: "Level 1", trialCount: 11, confidence: 90, rationale: "PD-L1 CPS drives first-line IO decision in recurrent/metastatic HNSCC." },
    { gene: "PIK3CA", variant: "E545K", alteration: "Missense · Exon 9", vaf: 26.8, classification: "Pathogenic", therapy: "PI3K inhibitor trial", evidenceLevel: "Level 3", trialCount: 7, confidence: 79, rationale: "Most common oncogenic mutation in HNSCC, enriched in HPV+ disease." },
  ],
  "Sarcoma": [
    { gene: "MDM2", variant: "Amplification 12q15", alteration: "Copy Number Gain", vaf: 0, classification: "Pathogenic", therapy: "MDM2 inhibitor trial / Surgery referral", evidenceLevel: "Level 2", trialCount: 6, confidence: 86, rationale: "Diagnostic for well/dedifferentiated liposarcoma; MDM2 antagonists in trials." },
    { gene: "NTRK", variant: "LMNA-NTRK1 Fusion", alteration: "Fusion", vaf: 0, classification: "Pathogenic", therapy: "Larotrectinib", evidenceLevel: "Level 1", trialCount: 7, confidence: 95, rationale: "Infantile fibrosarcoma and other NTRK sarcomas — TRK inhibition is transformative." },
    { gene: "ALK", variant: "RANBP2-ALK Fusion", alteration: "Fusion", vaf: 0, classification: "Pathogenic", therapy: "Crizotinib", evidenceLevel: "Level 1", trialCount: 5, confidence: 90, rationale: "Inflammatory myofibroblastic tumor with ALK fusion — ALK TKI approved." },
  ],
};

const DEFAULT_MATCHES: MatchTemplate[] = [
  { gene: "TP53", variant: "R248Q", alteration: "Missense · Exon 7", vaf: 37.6, classification: "Pathogenic", therapy: "Investigational — early phase referral", evidenceLevel: "Level 3", trialCount: 6, confidence: 76, rationale: "Most common tumor suppressor loss; no direct approved therapy — trial matching prioritized." },
  { gene: "BRCA2", variant: "S1982fs", alteration: "Frameshift", vaf: 22.1, classification: "Likely Pathogenic", therapy: "PARP inhibitor trial", evidenceLevel: "Level 2", trialCount: 8, confidence: 83, rationale: "HRD signature detected across uploaded research — PARP sensitivity hypothesis." },
  { gene: "PIK3CA", variant: "E545K", alteration: "Missense · Exon 9", vaf: 19.4, classification: "Pathogenic", therapy: "PI3K pathway trial", evidenceLevel: "Level 2", trialCount: 9, confidence: 80, rationale: "Helical domain hotspot activating PI3K-AKT signaling." },
  { gene: "TMB", variant: "11.2 mut/Mb", alteration: "Tumor Mutational Burden", vaf: 0, classification: "Predictive", therapy: "PD-1 blockade consideration", evidenceLevel: "Level 2", trialCount: 12, confidence: 77, rationale: "Intermediate-high TMB — immunotherapy biomarker panel recommended." },
];

function getTemplates(cancerType: string): MatchTemplate[] {
  return MATCH_LIBRARY[cancerType] ?? DEFAULT_MATCHES;
}

export const Actions = {
  listCases: defineAction({
    request: z.object({ limit: z.number().int().positive().max(100).default(50) }),
    response: z.object({
      cases: z.array(z.object({
        id: z.number(), label: z.string(), cancerType: z.string(), stage: z.string(), histology: z.string(), sampleType: z.string(), priorTherapy: z.string(), status: z.string(), created_at: z.string(),
        uploadCount: z.number(), matchCount: z.number(),
      })),
      stats: z.object({ totalCases: z.number(), totalUploads: z.number(), totalMatches: z.number(), actionable: z.number() }),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.cases).orderBy(desc(schema.cases.id)).limit(args.limit);
      const allUploads = await db.select().from(schema.uploads);
      const allMatches = await db.select().from(schema.matches);
      const cases = rows.map(r => ({
        id: r.id, label: r.label, cancerType: r.cancerType, stage: r.stage, histology: r.histology, sampleType: r.sampleType, priorTherapy: r.priorTherapy, status: r.status, created_at: r.createdAt.toISOString(),
        uploadCount: allUploads.filter(u => u.caseId === r.id).length,
        matchCount: allMatches.filter(m => m.caseId === r.id).length,
      }));
      return {
        cases,
        stats: {
          totalCases: rows.length,
          totalUploads: allUploads.length,
          totalMatches: allMatches.length,
          actionable: allMatches.filter(m => m.confidence >= 85).length,
        }
      };
    },
  }),

  createCase: defineAction({
    request: z.object({
      label: z.string().min(1).max(120),
      cancerType: z.string().min(1),
      stage: z.string().default("Stage IV"),
      histology: z.string().default(""),
      sampleType: z.string().default("Tissue NGS"),
      priorTherapy: z.string().default(""),
    }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const res = await db.insert(schema.cases).values({
        label: args.label, cancerType: args.cancerType, stage: args.stage, histology: args.histology, sampleType: args.sampleType, priorTherapy: args.priorTherapy, status: "intake",
      }).returning({ id: schema.cases.id });
      if (!res[0]) throw new Error("create failed");
      ctx.invalidateQueries();
      return { id: res[0].id };
    },
  }),

  deleteCase: defineAction({
    request: z.object({ id: z.number() }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      await db.delete(schema.uploads).where(eq(schema.uploads.caseId, args.id));
      await db.delete(schema.matches).where(eq(schema.matches.caseId, args.id));
      await db.delete(schema.cases).where(eq(schema.cases.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  getCaseDetail: defineAction({
    request: z.object({ caseId: z.number() }),
    response: z.object({
      uploads: z.array(z.object({ id: z.number(), fileName: z.string(), fileKind: z.string(), sizeKb: z.number(), created_at: z.string() })),
      matches: z.array(z.object({ id: z.number(), gene: z.string(), variant: z.string(), alteration: z.string(), vaf: z.number(), classification: z.string(), therapy: z.string(), evidenceLevel: z.string(), trialCount: z.number(), confidence: z.number(), rationale: z.string() })),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const ups = await db.select().from(schema.uploads).where(eq(schema.uploads.caseId, args.caseId)).orderBy(desc(schema.uploads.id));
      const mats = await db.select().from(schema.matches).where(eq(schema.matches.caseId, args.caseId)).orderBy(desc(schema.matches.confidence));
      return {
        uploads: ups.map(u => ({ id: u.id, fileName: u.fileName, fileKind: u.fileKind, sizeKb: u.sizeKb, created_at: u.createdAt.toISOString() })),
        matches: mats.map(m => ({ id: m.id, gene: m.gene, variant: m.variant, alteration: m.alteration, vaf: m.vaf, classification: m.classification, therapy: m.therapy, evidenceLevel: m.evidenceLevel, trialCount: m.trialCount, confidence: m.confidence, rationale: m.rationale })),
      };
    },
  }),

  addUpload: defineAction({
    request: z.object({ caseId: z.number(), fileName: z.string().min(1), fileKind: z.string().default("Research PDF"), sizeKb: z.number().int().min(0).default(0) }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const res = await db.insert(schema.uploads).values({ caseId: args.caseId, fileName: args.fileName, fileKind: args.fileKind, sizeKb: args.sizeKb }).returning({ id: schema.uploads.id });
      if (!res[0]) throw new Error("upload failed");
      ctx.invalidateQueries();
      return { id: res[0].id };
    },
  }),

  deleteUpload: defineAction({
    request: z.object({ id: z.number() }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      await db.delete(schema.uploads).where(eq(schema.uploads.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  runMatch: defineAction({
    request: z.object({ caseId: z.number() }),
    response: z.object({ count: z.number(), ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ count: number; ok: true }> {
      const db = ctx.db<typeof schema>();
      const caseRows = await db.select().from(schema.cases).where(eq(schema.cases.id, args.caseId));
      const c = caseRows[0];
      if (!c) throw new Error("Case not found");
      // clear prior matches for re-run
      await db.delete(schema.matches).where(eq(schema.matches.caseId, args.caseId));
      const templates = getTemplates(c.cancerType);
      // slight deterministic variation by case id so re-runs feel alive but stable
      for (const t of templates) {
        const jitter = ((args.caseId * 7 + t.gene.length * 3) % 5) - 2;
        await db.insert(schema.matches).values({
          caseId: args.caseId, gene: t.gene, variant: t.variant, alteration: t.alteration, vaf: t.vaf, classification: t.classification, therapy: t.therapy, evidenceLevel: t.evidenceLevel, trialCount: t.trialCount, confidence: Math.min(99, Math.max(62, t.confidence + jitter)), rationale: t.rationale,
        });
      }
      await db.update(schema.cases).set({ status: "matched" }).where(eq(schema.cases.id, args.caseId));
      ctx.invalidateQueries();
      return { count: templates.length, ok: true };
    },
  }),
} satisfies ActionsModule;
