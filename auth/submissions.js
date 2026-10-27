'use strict';

const { newId } = require('./store');
const { fail } = require('./errors');
const { requireActiveAccount, requireRole } = require('./roles');

// Research submissions and the immutable audit log.
//
// Data-integrity rules enforced here:
//  * A doctor's submission ALWAYS lands as `pending_review`. There is no
//    code path that creates — or edits into existence — a live record:
//    the only transition into the live dataset is a reviewer's approve().
//  * Edits never overwrite: every edit increments `version` and appends the
//    prior content to `history`.
//  * Deletes are soft: `deletedAt`/`deletedBy` are set, the record stays.
//  * Every mutation appends an audit entry. Audit entries are append-only —
//    AuditLog exposes record()/list() and no update or delete operation.

class AuditLog {
    constructor(store) {
        this.store = store;
    }

    async record({ actorId, actorRole, action, entityType, entityId, details = {} }) {
        const entry = {
            id: newId('aud'),
            at: new Date().toISOString(),
            actorId,
            actorRole,
            action,
            entityType,
            entityId,
            details,
        };
        await this.store.put('audit', entry.id, entry);
        return entry;
    }

    async list({ entityType, entityId } = {}) {
        let entries = await this.store.all('audit');
        if (entityType) entries = entries.filter(e => e.entityType === entityType);
        if (entityId) entries = entries.filter(e => e.entityId === entityId);
        // Array.prototype.sort is stable, so entries sharing a timestamp
        // keep their insertion (chronological) order.
        return entries.sort((a, b) => a.at.localeCompare(b.at));
    }
}

function snapshotOf(submission) {
    return {
        title: submission.title,
        summary: submission.summary,
        biomarkers: [...submission.biomarkers],
        cancerType: submission.cancerType,
        sourceUrl: submission.sourceUrl,
    };
}

function validateContent({ title, summary, biomarkers, cancerType }) {
    if (!title || typeof title !== 'string' || title.trim().length < 4) {
        fail('SUBMISSION_INVALID', 'A submission needs a descriptive title.');
    }
    if (!summary || typeof summary !== 'string' || summary.trim().length < 20) {
        fail('SUBMISSION_INVALID', 'A submission needs a summary of at least 20 characters.');
    }
    if (!Array.isArray(biomarkers) || biomarkers.length === 0
        || biomarkers.some(b => typeof b !== 'string' || b.trim() === '')) {
        fail('SUBMISSION_INVALID', 'A submission must list at least one biomarker.');
    }
    if (!cancerType || typeof cancerType !== 'string') {
        fail('SUBMISSION_INVALID', 'A submission must name the cancer type studied.');
    }
}

class SubmissionService {
    constructor(store, { audit } = {}) {
        this.store = store;
        this.audit = audit || new AuditLog(store);
    }

    async #log(actor, action, submission, details = {}) {
        await this.audit.record({
            actorId: actor.id,
            actorRole: actor.role,
            action,
            entityType: 'submission',
            entityId: submission.id,
            details,
        });
    }

    async #mustFind(id) {
        const submission = await this.store.get('submissions', id);
        if (!submission || submission.deletedAt) fail('SUBMISSION_NOT_FOUND', 'Submission not found.', 404);
        return submission;
    }

    #assertOwnerOrAdmin(actor, submission) {
        if (actor.role !== 'admin' && submission.submittedBy !== actor.id) {
            fail('FORBIDDEN', 'You can only modify your own submissions.', 403);
        }
    }

    // Creates a submission in `pending_review` — always. Even an admin
    // cannot create one directly in the live dataset through this API.
    async createSubmission(actor, content = {}) {
        requireActiveAccount(actor);
        requireRole(actor, 'doctor', 'admin');
        validateContent(content);
        const now = new Date().toISOString();
        const submission = {
            id: newId('sub'),
            submittedBy: actor.id,
            submitterEmail: actor.email,
            title: content.title.trim(),
            summary: content.summary.trim(),
            biomarkers: content.biomarkers.map(b => b.trim()),
            cancerType: content.cancerType.trim(),
            sourceUrl: content.sourceUrl || null,
            status: 'pending_review',
            version: 1,
            history: [],
            reviewNote: null,
            reviewedBy: null,
            reviewedAt: null,
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
            deletedBy: null,
        };
        await this.store.put('submissions', submission.id, submission);
        await this.#log(actor, 'submission.created', submission, { version: 1 });
        return submission;
    }

    // Editing a submission that was already reviewed sends it back through
    // review: status returns to `pending_review` so changed content can
    // never ride on an earlier approval into the live dataset.
    async editSubmission(actor, id, content = {}) {
        requireActiveAccount(actor);
        const submission = await this.#mustFind(id);
        this.#assertOwnerOrAdmin(actor, submission);
        const next = { ...snapshotOf(submission), ...content };
        validateContent(next);
        submission.history.push({
            version: submission.version,
            editedAt: submission.updatedAt,
            status: submission.status,
            ...snapshotOf(submission),
        });
        submission.title = next.title.trim();
        submission.summary = next.summary.trim();
        submission.biomarkers = next.biomarkers.map(b => b.trim());
        submission.cancerType = next.cancerType.trim();
        submission.sourceUrl = next.sourceUrl || null;
        submission.version += 1;
        if (submission.status !== 'pending_review') {
            submission.status = 'pending_review';
            submission.reviewNote = null;
            submission.reviewedBy = null;
            submission.reviewedAt = null;
        }
        submission.updatedAt = new Date().toISOString();
        await this.store.put('submissions', submission.id, submission);
        await this.#log(actor, 'submission.edited', submission, { version: submission.version });
        return submission;
    }

    async #review(actor, id, note, decision) {
        requireActiveAccount(actor);
        requireRole(actor, 'reviewer', 'admin');
        const submission = await this.#mustFind(id);
        if (submission.submittedBy === actor.id) {
            fail('SELF_REVIEW_FORBIDDEN', 'You cannot review your own submission.', 403);
        }
        if (submission.status !== 'pending_review') {
            fail('NOT_PENDING_REVIEW', 'Only submissions awaiting review can be reviewed.', 409);
        }
        if (decision === 'rejected' && (!note || String(note).trim() === '')) {
            fail('REVIEW_NOTE_REQUIRED', 'Rejecting a submission requires a note explaining why.');
        }
        submission.status = decision; // "approved" | "rejected"
        submission.reviewNote = note ? String(note) : null;
        submission.reviewedBy = actor.id;
        submission.reviewedAt = new Date().toISOString();
        submission.updatedAt = submission.reviewedAt;
        await this.store.put('submissions', submission.id, submission);
        await this.#log(actor, `submission.${decision}`, submission, { note: submission.reviewNote });
        return submission;
    }

    async approveSubmission(actor, id, { note } = {}) {
        return this.#review(actor, id, note, 'approved');
    }

    async rejectSubmission(actor, id, { note } = {}) {
        return this.#review(actor, id, note, 'rejected');
    }

    // Soft delete: the record (and its history and audit trail) is retained.
    async deleteSubmission(actor, id) {
        requireActiveAccount(actor);
        const submission = await this.#mustFind(id);
        this.#assertOwnerOrAdmin(actor, submission);
        submission.deletedAt = new Date().toISOString();
        submission.deletedBy = actor.id;
        submission.updatedAt = submission.deletedAt;
        await this.store.put('submissions', submission.id, submission);
        await this.#log(actor, 'submission.deleted', submission, {});
        return submission;
    }

    async getSubmission(actor, id) {
        requireActiveAccount(actor);
        const submission = await this.#mustFind(id);
        if (actor.role === 'doctor' && submission.submittedBy !== actor.id) {
            fail('FORBIDDEN', 'Doctors can only view their own submissions.', 403);
        }
        return submission;
    }

    async listMine(actor) {
        requireActiveAccount(actor);
        return this.store.find('submissions', s => s.submittedBy === actor.id && !s.deletedAt);
    }

    async listPendingReview(actor) {
        requireActiveAccount(actor);
        requireRole(actor, 'reviewer', 'admin');
        return this.store.find('submissions', s => s.status === 'pending_review' && !s.deletedAt);
    }

    // The "live dataset": approved submissions only. Nothing reaches this
    // list except through a reviewer's approve().
    async listApproved() {
        return this.store.find('submissions', s => s.status === 'approved' && !s.deletedAt);
    }

    async auditTrailFor(id) {
        return this.audit.list({ entityType: 'submission', entityId: id });
    }
}

module.exports = { SubmissionService, AuditLog };
