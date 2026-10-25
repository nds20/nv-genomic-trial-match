const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const SUPPORTED_EXTENSIONS = new Set(['.txt', '.csv', '.tsv', '.json']);
const HEADER_VALUES = new Set(['BIOMARKER', 'GENE', 'SYMBOL']);

function validationError(message, status = 400) {
    const error = new Error(message);
    error.status = status;
    return error;
}

function getKnownBiomarkers(trials) {
    if (!Array.isArray(trials)) throw new TypeError('Trials must be an array.');
    return new Set(trials.flatMap(trial => {
        if (!trial || !Array.isArray(trial.requiredBiomarkers)) {
            throw new TypeError('Each trial must define requiredBiomarkers.');
        }
        return trial.requiredBiomarkers.map(biomarker => String(biomarker).toUpperCase());
    }));
}

function normalizeBiomarkers(values, knownBiomarkers, requireOne = false) {
    if (!Array.isArray(values)) throw validationError('Biomarkers must be provided as a list.');
    if (values.length > 5000) throw validationError('Upload no more than 5,000 biomarker symbols.');

    const biomarkers = values.map(value =>
        typeof value === 'string' ? value.trim().toUpperCase() : ''
    );
    if (biomarkers.some(value => !/^[A-Z][A-Z0-9-]{0,19}$/.test(value) || !knownBiomarkers.has(value))) {
        throw validationError('Upload only recognized biomarker symbols. Patient details and free text are not accepted.');
    }
    if (requireOne && !biomarkers.length) throw validationError('No biomarker symbols were found.');
    return [...new Set(biomarkers)];
}

class LenhardAIEngine {
    constructor() {
        this.version = '1.0.0-alpha';
    }

    analyzeResearchFile(file, trials) {
        if (!file || !Buffer.isBuffer(file.buffer)) {
            throw validationError('Upload a valid research file.');
        }
        if (file.buffer.length > MAX_UPLOAD_BYTES) {
            throw validationError('File exceeds the 5 MB limit.', 413);
        }

        const extension = require('path').extname(file.originalname || '').toLowerCase();
        if (!SUPPORTED_EXTENSIONS.has(extension)) {
            throw validationError('Use a .txt, .csv, .tsv or .json biomarker list.', 415);
        }

        let text;
        try {
            text = new TextDecoder('utf-8', { fatal: true }).decode(file.buffer);
        } catch {
            throw validationError('File must be valid UTF-8 text.');
        }

        const biomarkers = this.parseBiomarkerList(text, extension, trials);
        return {
            biomarkers,
            results: this.match(biomarkers, trials)
        };
    }

    parseBiomarkerList(text, extension, trials) {
        const knownBiomarkers = getKnownBiomarkers(trials);
        let values;

        if (extension === '.json') {
            let data;
            try {
                data = JSON.parse(text);
            } catch {
                throw validationError('JSON must contain only a biomarkers array.');
            }
            if (!data || Array.isArray(data) || Object.keys(data).length !== 1 ||
                !Array.isArray(data.biomarkers) ||
                !data.biomarkers.every(value => typeof value === 'string')) {
                throw validationError('JSON must contain only a biomarkers array of gene symbols.');
            }
            values = data.biomarkers;
        } else {
            values = text.split(/\r?\n/).map(line => {
                if (line.includes(',') || line.includes('\t')) {
                    throw validationError('Upload one biomarker symbol per line, with no extra columns.');
                }
                return line.trim();
            }).filter(Boolean);
        }

        if (values.length && HEADER_VALUES.has(values[0].trim().toUpperCase())) {
            values = values.slice(1);
        }
        return normalizeBiomarkers(values, knownBiomarkers, true);
    }

    match(patientBiomarkers, trials) {
        if (!Array.isArray(patientBiomarkers)) {
            throw new TypeError('Patient biomarkers must be an array.');
        }
        if (!Array.isArray(trials)) {
            throw new TypeError('Trials must be an array.');
        }

        const normalizedBiomarkers = new Set(
            normalizeBiomarkers(patientBiomarkers, getKnownBiomarkers(trials))
        );

        return trials.map(trial => {
            if (!trial || !Array.isArray(trial.requiredBiomarkers)) {
                throw new TypeError('Each trial must define requiredBiomarkers.');
            }
            const required = trial.requiredBiomarkers;
            const matchedBiomarkers = required.filter(biomarker =>
                normalizedBiomarkers.has(String(biomarker).toUpperCase())
            );
            const score = required.length
                ? (matchedBiomarkers.length / required.length) * 100
                : 0;
            return {
                trialId: trial.id,
                trialName: trial.name,
                matchScore: `${score.toFixed(2)}%`,
                matchedBiomarkers,
                status: score > 50 ? 'POTENTIAL_MATCH' : 'LOW_MATCH'
            };
        }).sort((a, b) => parseFloat(b.matchScore) - parseFloat(a.matchScore));
    }
}

module.exports = LenhardAIEngine;
