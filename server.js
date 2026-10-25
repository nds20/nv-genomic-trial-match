const express = require('express');
const { rateLimit } = require('express-rate-limit');
const helmet = require('helmet');
const multer = require('multer');
const path = require('path');
const LenhardAIEngine = require('./engine/LenhardEngine');
const TrialRepository = require('./engine/TrialRepository');

const app = express();
const engine = new LenhardAIEngine();
const trialRepository = new TrialRepository();
if (process.env.TRUST_PROXY === 'true') app.set('trust proxy', 1);
app.use(helmet());
app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
});

const uploadLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Upload limit reached. Try again later.' }
});

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024, files: 1 },
    fileFilter: (req, file, cb) => {
        const ok = /\.(txt|csv|json|tsv)$/i.test(file.originalname);
        const error = Object.assign(
            new Error('Unsupported file type. Use .txt, .csv, .tsv or .json.'),
            { status: 415 }
        );
        cb(ok ? null : error, ok);
    }
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', trialStore: trialRepository.container ? 'cosmos' : 'demo' });
});

app.get('/api/trials', async (req, res, next) => {
    try {
        res.json(await trialRepository.getTrials());
    } catch (error) {
        next(error);
    }
});

app.post('/api/upload', uploadLimiter, upload.single('research'), async (req, res, next) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'Choose a research file to upload.' });
        const trials = await trialRepository.getTrials();
        res.json(engine.analyzeResearchFile(req.file, trials));
    } catch (error) {
        next(error);
    }
});

app.use((err, req, res, next) => {
    const status = err.status || (err instanceof multer.MulterError
        ? (err.code === 'LIMIT_FILE_SIZE' ? 413 : 400)
        : 500);
    if (status === 500) console.error('[API] Request failed:', err);
    res.status(status).json({ error: status === 500 ? 'The request could not be completed.' : err.message });
});

const port = process.env.PORT || 3000;
if (require.main === module) {
    app.listen(port, () => console.log(`Server running at http://localhost:${port}`));
}

module.exports = { app };
