import { promisify } from 'util';

import { Meteor } from 'meteor/meteor';
import { MongoInternals } from 'meteor/mongo';
import s from 'underscore.string';
import { MongoClient, Cursor, Timestamp, Db } from 'mongodb';
import _urlParser from 'mongodb/lib/url_parser';

const urlParser = promisify(_urlParser);

class OplogHandle {
	dbName: string;

	client: MongoClient;

	stream: Cursor;

	db: Db;

	usingChangeStream: boolean;

	async isChangeStreamAvailable(): Promise<boolean> {
		if (process.env.IGNORE_CHANGE_STREAM) {
			return false;
		}

		const { mongo } = MongoInternals.defaultRemoteCollectionDriver();
		const { storageEngine } = await mongo.db.command({ serverStatus: 1 });
		return storageEngine?.name === 'wiredTiger';
	}

	async start(): Promise<OplogHandle> {
		this.usingChangeStream = await this.isChangeStreamAvailable();
		const oplogUrl = this.usingChangeStream ? process.env.MONGO_URL : process.env.MONGO_OPLOG_URL;

		const urlParsed = await urlParser(oplogUrl);
		if (!this.usingChangeStream && (!oplogUrl || urlParsed.dbName !== 'local')) {
			throw Error("$MONGO_OPLOG_URL must be set to the 'local' database of a Mongo replica set");
		}

		if (!oplogUrl) {
			throw Error('$MONGO_URL must be set');
		}

		if (process.env.MONGO_OPLOG_URL) {
			const urlParsed = await urlParser(process.env.MONGO_URL);
			this.dbName = urlParsed.dbName;
		}

		this.client = new MongoClient(oplogUrl, {
			useUnifiedTopology: true,
			useNewUrlParser: true,
			...!this.usingChangeStream && { poolSize: 1 },
		});

		await this.client.connect();
		this.db = this.client.db();

		if (!this.usingChangeStream) {
			await this.startOplog();
		}

		return this;
	}

	async startOplog(): Promise<void> {
		const isMasterDoc = await this.db.admin().command({ ismaster: 1 });
		if (!isMasterDoc || !isMasterDoc.setName) {
			throw Error("$MONGO_OPLOG_URL must be set to the 'local' database of a Mongo replica set");
		}

		const oplogCollection = this.db.collection('oplog.rs');

		const lastOplogEntry = await oplogCollection.findOne<{ts: Timestamp}>({}, { sort: { $natural: -1 }, projection: { _id: 0, ts: 1 } });

		const oplogSelector = {
			ns: new RegExp(`^(?:${ [
				s.escapeRegExp(`${ this.dbName }.`),
				s.escapeRegExp('admin.$cmd'),
			].join('|') })`),

			op: { $in: ['i', 'u', 'd'] },
			...lastOplogEntry && { ts: { $gt: lastOplogEntry.ts } },
		};

		console.log(oplogSelector);
		this.stream = oplogCollection.find(oplogSelector, {
			tailable: true,
			// awaitData: true,
		}).stream();
	}

	onOplogEntry(query: {collection: string}, callback: Function): void {
		if (this.usingChangeStream) {
			return this._onOplogEntryChangeStream(query, callback);
		}

		return this._onOplogEntryOplog(query, callback);
	}

	_onOplogEntryOplog(query: {collection: string}, callback: Function): void {
		this.stream.on('data', Meteor.bindEnvironment((buffer) => {
			const doc = buffer as any;
			if (doc.ns === `${ this.dbName }.${ query.collection }`) {
				// console.log('doc', doc);
				callback({
					id: doc.op === 'u' ? doc.o2._id : doc.o._id,
					op: doc,
				});
			}
		}));
	}

	_onOplogEntryChangeStream(query: {collection: string}, callback: Function): void {
		this.db.collection(query.collection).watch([], { /* fullDocument: 'updateLookup' */ }).on('change', Meteor.bindEnvironment((event) => {
			// console.log(event);
			switch (event.operationType) {
				case 'insert':
					callback({
						id: event.documentKey._id,
						op: {
							op: 'i',
							o: event.fullDocument,
						},
					});
					break;
				case 'update':
					callback({
						id: event.documentKey._id,
						op: {
							op: 'u',
							// o: event.fullDocument,
							o: {
								$set: event.updateDescription.updatedFields,
								$unset: event.updateDescription.removedFields,
							},
						},
					});
					break;
				case 'delete':
					callback({
						id: event.documentKey._id,
						op: {
							op: 'd',
						},
					});
					break;
			}
		}));
	}

	_defineTooFarBehind(): void {
		//
	}
}

process.env.USE_NEW_OPLOG = 'true';
process.env.IGNORE_CHANGE_STREAM = 'true';

const oplogHandle = process.env.USE_NEW_OPLOG ? new OplogHandle().start() : undefined;

export const getOplogHandle = async (): Promise<OplogHandle | undefined> => {
	const { mongo } = MongoInternals.defaultRemoteCollectionDriver();

	if (process.env.USE_NEW_OPLOG) {
		return oplogHandle;
	}

	if (mongo._oplogHandle?.onOplogEntry) {
		return mongo._oplogHandle;
	}
};
