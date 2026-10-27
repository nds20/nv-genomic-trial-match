'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

// Pluggable data store for the auth prototype.
//
// The interface is deliberately tiny and record-oriented so the JSON-file
// implementation below can later be swapped for an Azure Cosmos container
// per collection (users, invites, submissions, audit, sessions) without
// touching the auth business logic:
//
//   get(collection, id)            -> record | undefined
//   put(collection, id, record)    -> record (insert or replace by id)
//   all(collection)                -> array of records
//   find(collection, predicateFn)  -> array of matching records
//
// `MemoryStore` keeps everything in process memory (used by tests and demos).
// `JsonFileStore` persists the whole dataset to one JSON file on each write;
// it is adequate for a single-instance prototype only — it is NOT safe for
// concurrent writers or multiple server instances.

const COLLECTIONS = ['users', 'invites', 'submissions', 'audit', 'sessions'];

function emptyData() {
    return Object.fromEntries(COLLECTIONS.map(name => [name, {}]));
}

function assertCollection(name) {
    if (!COLLECTIONS.includes(name)) {
        throw new Error(`Unknown collection: ${name}`);
    }
}

class MemoryStore {
    constructor() {
        this.data = emptyData();
    }

    async get(collection, id) {
        assertCollection(collection);
        const record = this.data[collection][id];
        return record ? structuredClone(record) : undefined;
    }

    async put(collection, id, record) {
        assertCollection(collection);
        this.data[collection][id] = structuredClone(record);
        return structuredClone(record);
    }

    async all(collection) {
        assertCollection(collection);
        return Object.values(this.data[collection]).map(r => structuredClone(r));
    }

    async find(collection, predicate) {
        return (await this.all(collection)).filter(predicate);
    }
}

class JsonFileStore extends MemoryStore {
    constructor(filePath) {
        super();
        this.filePath = filePath;
        if (fs.existsSync(filePath)) {
            const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            for (const name of COLLECTIONS) {
                this.data[name] = parsed[name] || {};
            }
        }
    }

    async put(collection, id, record) {
        const saved = await super.put(collection, id, record);
        this.#flush();
        return saved;
    }

    #flush() {
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        const tmp = `${this.filePath}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
        fs.renameSync(tmp, this.filePath);
    }
}

function newId(prefix) {
    return `${prefix}_${randomUUID()}`;
}

module.exports = { MemoryStore, JsonFileStore, COLLECTIONS, newId };
