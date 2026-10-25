const { CosmosClient } = require('@azure/cosmos');
const sampleTrials = require('../data/trials.json');

class TrialRepository {
    constructor(env = process.env) {
        this.container = null;
        const endpoint = env.COSMOS_ENDPOINT;
        const key = env.COSMOS_KEY;

        if (!endpoint && !key) return;
        if (!endpoint || !key) {
            throw new Error('Set both COSMOS_ENDPOINT and COSMOS_KEY to enable Cosmos DB.');
        }
        if (!env.COSMOS_DATABASE || !env.COSMOS_CONTAINER) {
            throw new Error('Set COSMOS_DATABASE and COSMOS_CONTAINER to enable Cosmos DB.');
        }

        this.container = new CosmosClient({ endpoint, key })
            .database(env.COSMOS_DATABASE)
            .container(env.COSMOS_CONTAINER);
    }

    async getTrials() {
        if (!this.container) return sampleTrials;

        const { resources } = await this.container.items
            .query('SELECT * FROM c')
            .fetchAll();
        return resources.map(trial => {
            if (typeof trial.id !== 'string' || typeof trial.name !== 'string' ||
                !Array.isArray(trial.requiredBiomarkers) ||
                !trial.requiredBiomarkers.every(biomarker => typeof biomarker === 'string')) {
                throw new Error('Cosmos DB contains a trial with an invalid schema.');
            }
            return {
                id: trial.id,
                name: trial.name,
                requiredBiomarkers: trial.requiredBiomarkers
            };
        });
    }
}

module.exports = TrialRepository;
