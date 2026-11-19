/* global Zotero, APP_SHUTDOWN */

/**
 * Zotero Dedupe
 *
 * Exposes endpoints on Zotero's local HTTP server (port 23119):
 *   /dedupe/check     - duplicate check
 *   /dedupe/save      - save an item into the selected collection
 *   /dedupe/save-pdf  - attach a browser-downloaded PDF
 *   /dedupe/merge     - merge duplicate items (token protected, dry run by default)
 */

var ZoteroDedupe = {
	id: "zotero-dedupe@example.com",
	version: "1.2.0",
	checkPath: "/dedupe/check",
	pingPath: "/dedupe/ping",
	savePath: "/dedupe/save",
	savePdfPath: "/dedupe/save-pdf",
	collectionsPath: "/dedupe/collections",
	mergePath: "/dedupe/merge",

	async startup() {
		try {
			if (Zotero.initializationPromise) {
				await Zotero.initializationPromise;
			}
			this.registerEndpoints();
			Zotero.debug(
				"[zotero-dedupe] listening on http://127.0.0.1:"
				+ Zotero.Prefs.get("httpServer.port") + this.checkPath
			);
		}
		catch (error) {
			this.log("startup failed");
			try {
				Zotero.logError(error);
			}
			catch (_) {}
		}
	},

	shutdown() {
		if (Zotero.Server && Zotero.Server.Endpoints) {
			delete Zotero.Server.Endpoints[this.checkPath];
			delete Zotero.Server.Endpoints[this.pingPath];
			delete Zotero.Server.Endpoints[this.savePath];
			delete Zotero.Server.Endpoints[this.savePdfPath];
			delete Zotero.Server.Endpoints[this.collectionsPath];
			delete Zotero.Server.Endpoints[this.mergePath];
		}
	},

	log(message) {
		try {
			Zotero.debug("[zotero-dedupe] " + message);
		}
		catch (_) {}
	},

	json(status, data) {
		return [status, "application/json", JSON.stringify(data)];
	},

	registerEndpoints() {
		if (!Zotero.Server || !Zotero.Server.Endpoints) {
			throw new Error("Zotero local HTTP server is not available");
		}

		let self = this;

		function Endpoint() {}
		Endpoint.prototype.supportedMethods = ["GET", "POST"];
		Endpoint.prototype.supportedDataTypes = [
			"application/json",
			"application/pdf",
			"application/octet-stream"
		];
		// The request comes from a browser extension, so opt into browser access.
		Endpoint.prototype.allowRequestsFromUnsafeWebContent = true;

		Endpoint.prototype.init = async function (request) {
			try {
				if (request.pathname === self.mergePath) {
					return await self.handleMergeRequest(request);
				}
				if (request.pathname === self.savePath) {
					return await self.handleSaveRequest(request);
				}
				if (request.pathname === self.savePdfPath) {
					return await self.handleSavePdfRequest(request);
				}
				if (request.pathname === self.collectionsPath) {
					return await self.handleCollectionsRequest();
				}

				if (request.method === "GET") {
					return self.json(200, self.status());
				}

				let payload = self.parsePayload(request);
				let item = payload.item && typeof payload.item === "object"
					? payload.item
					: payload;
				let options = payload.options && typeof payload.options === "object"
					? payload.options
					: {};

				let result = await self.checkDuplicate(item, options);
				result.target = self.safeTargetInfo();
				return self.json(200, result);
			}
			catch (error) {
				let message = error && error.message ? error.message : String(error);
				self.log("request failed: " + message);
				return self.json(500, {
					ok: false,
					available: true,
					duplicate: false,
					error: message
				});
			}
		};

		Zotero.Server.Endpoints[this.checkPath] = Endpoint;
		Zotero.Server.Endpoints[this.pingPath] = Endpoint;
		Zotero.Server.Endpoints[this.savePath] = Endpoint;
		Zotero.Server.Endpoints[this.savePdfPath] = Endpoint;
		Zotero.Server.Endpoints[this.collectionsPath] = Endpoint;
		Zotero.Server.Endpoints[this.mergePath] = Endpoint;
	},

	status() {
		return {
			ok: true,
			available: true,
			name: "Zotero Dedupe",
			version: this.version,
			zoteroVersion: Zotero.version,
			endpoint: this.checkPath,
			libraryID: Zotero.Libraries.userLibraryID,
			target: this.safeTargetInfo()
		};
	},

	parsePayload(request) {
		let payload = request.data;
		if (typeof payload === "string") {
			payload = payload ? JSON.parse(payload) : {};
		}
		if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
			throw new Error("A JSON object is required");
		}
		return payload;
	},

	getSaveTarget() {
		// Reuse Zotero Connector's own target logic so the plugin saves into the
		// same collection that the connector would use.
		try {
			if (Zotero.Server && Zotero.Server.Connector
					&& Zotero.Server.Connector.getSaveTarget) {
				let target = Zotero.Server.Connector.getSaveTarget();
				if (target && target.library) {
					return target;
				}
			}
		}
		catch (error) {
			this.log("getSaveTarget failed: " + error.message);
		}

		let library = Zotero.Libraries.get(Zotero.Libraries.userLibraryID);
		let collection = null;
		try {
			let pane = Zotero.getActiveZoteroPane && Zotero.getActiveZoteroPane();
			if (pane && pane.getSelectedCollection) {
				collection = pane.getSelectedCollection() || null;
			}
		}
		catch (_) {}
		return {
			library,
			collection,
			editable: !!(library && library.editable)
		};
	},

	safeTargetInfo() {
		try {
			return this.targetInfo(this.getSaveTarget());
		}
		catch (_) {
			return null;
		}
	},

	targetInfo(target) {
		let library = target && target.library;
		if (!library) {
			return null;
		}
		let collection = target.collection
			? this.collectionInfo(target.collection)
			: null;
		return {
			library: {
				libraryID: library.libraryID,
				name: library.name,
				editable: !!library.editable,
				isGroup: !!library.isGroup
			},
			collection,
			path: collection
				? library.name + " / " + collection.path
				: library.name
		};
	},

	collectionInfo(collection) {
		let names = [];
		let current = collection;
		let guard = 0;
		while (current && guard++ < 100) {
			names.unshift(current.name);
			current = current.parentID
				? Zotero.Collections.get(current.parentID)
				: null;
		}
		return {
			collectionID: collection.id,
			key: collection.key,
			name: collection.name,
			path: names.join(" / ")
		};
	},

	prepareItemForSave(item) {
		let json = JSON.parse(JSON.stringify(item || {}));
		for (let key of [
			"pdfUrl", "pdfURL", "pdf_url", "candidatePDFs", "candidatePdfs"
		]) {
			delete json[key];
		}

		if (!json.itemType || !Zotero.ItemTypes.getID(json.itemType)) {
			json.itemType = "journalArticle";
		}
		json.id = json.id || Zotero.Utilities.randomString(12);
		json.creators = Array.isArray(json.creators)
			? json.creators
				.filter(creator => creator && (creator.lastName || creator.name || creator.firstName))
				.map(creator => ({
					creatorType: creator.creatorType || "author",
					firstName: creator.firstName || "",
					lastName: creator.lastName || creator.name || ""
				}))
			: [];
		return json;
	},

	async handleCollectionsRequest() {
		let target = this.getSaveTarget();
		let library = target.library
			|| Zotero.Libraries.get(Zotero.Libraries.userLibraryID);

		if (!library) {
			throw new Error("No Zotero library is available");
		}

		let collections = Zotero.Collections
			.getByLibrary(library.libraryID, true, false)
			.map(collection => ({
				collectionID: collection.id,
				key: collection.key,
				name: collection.name,
				level: collection.level || 0,
				parentID: collection.parentID || null,
				path: this.collectionInfo(collection).path
			}));

		return this.json(200, {
			ok: true,
			library: {
				libraryID: library.libraryID,
				name: library.name,
				editable: !!library.editable,
				isGroup: !!library.isGroup
			},
			selectedCollectionID: target.collection ? target.collection.id : null,
			target: this.targetInfo(target),
			collections
		});
	},

	resolveCollection(target, options) {
		let hasCollectionID = Object.prototype.hasOwnProperty.call(
			options || {}, "collectionID"
		);
		if (!hasCollectionID && !(options && options.collectionKey)) {
			return target.collection;
		}

		let id = options.collectionID;
		if (id === null || id === undefined || id === "" || id === 0 || id === "0") {
			// 0 means "Library root"
			return null;
		}

		let collection = options.collectionKey
			? Zotero.Collections.getByLibraryAndKey(
				target.library.libraryID,
				String(options.collectionKey)
			)
			: Zotero.Collections.get(Number(id));

		if (!collection || collection.deleted) {
			throw new Error("Collection not found: " + (id || options.collectionKey));
		}
		if (collection.libraryID !== target.library.libraryID) {
			throw new Error("Collection is in a different library");
		}
		return collection;
	},

	async handleSaveRequest(request) {
		let payload = this.parsePayload(request);
		let item = payload.item && typeof payload.item === "object"
			? payload.item
			: payload;
		let options = payload.options && typeof payload.options === "object"
			? payload.options
			: {};
		let currentTarget = this.getSaveTarget();

		if (!currentTarget.library) {
			throw new Error("No Zotero library is available");
		}
		if (!currentTarget.library.editable) {
			throw new Error("The selected Zotero library is read-only");
		}

		let saveTarget = {
			library: currentTarget.library,
			collection: this.resolveCollection(currentTarget, options),
			editable: currentTarget.editable
		};

		let JSONItem = this.prepareItemForSave(item);
		let saver = new Zotero.Translate.ItemSaver({
			libraryID: saveTarget.library.libraryID,
			collections: saveTarget.collection ? [saveTarget.collection.id] : undefined,
			attachmentMode: Zotero.Translate.ItemSaver.ATTACHMENT_MODE_IGNORE
		});
		let saved = await saver.saveItems([JSONItem], () => 0, () => 0);
		let savedItem = (saved || []).find(
			candidate => candidate && candidate.isRegularItem && candidate.isRegularItem()
		) || (saved || [])[0];

		if (!savedItem) {
			throw new Error("Zotero did not return a saved item");
		}

		return this.json(200, {
			ok: true,
			item: this.snapshotItem(savedItem),
			target: this.targetInfo(saveTarget),
			pdfSupported: true,
			savedAt: new Date().toISOString()
		});
	},

	async handleSavePdfRequest(request) {
		let requestType = String(
			request.headers["content-type"] || ""
		).split(";")[0].trim().toLowerCase();
		if (requestType === "application/pdf"
				|| requestType === "application/octet-stream") {
			return this.handleRawPdfRequest(request);
		}

		let payload = this.parsePayload(request);
		let itemID = Number(payload.itemID || payload.itemId);
		let parentItem = Number.isInteger(itemID) && itemID > 0
			? Zotero.Items.get(itemID)
			: null;

		if (!parentItem || !parentItem.isRegularItem()) {
			throw new Error("Parent item not found: " + (payload.itemID || payload.itemId));
		}

		let title = payload.title || "Full Text PDF";
		let attachment;

		if (payload.data) {
			let base64 = String(payload.data);
			if (base64.length > 140 * 1024 * 1024) {
				throw new Error("PDF is too large");
			}
			let bytes = this.base64ToBytes(base64);
			let prefix = new TextDecoder().decode(bytes.slice(0, 1024));
			if (!prefix.includes("%PDF-")) {
				throw new Error("The downloaded file is not a PDF");
			}

			let path = PathUtils.join(
				PathUtils.tempDir,
				"zotero-dedupe-" + Zotero.Utilities.randomString(12) + ".pdf"
			);
			await IOUtils.write(path, bytes);
			try {
				attachment = await Zotero.Attachments.importFromFile({
					file: path,
					parentItemID: parentItem.id,
					title,
					fileBaseName: title,
					contentType: "application/pdf"
				});
			}
			finally {
				try {
					await IOUtils.remove(path);
				}
				catch (_) {}
			}
		}
		else if (payload.url) {
			attachment = await Zotero.Attachments.importFromURL({
				url: payload.url,
				parentItemID: parentItem.id,
				title
			});
		}
		else {
			throw new Error("No PDF data or URL provided");
		}

		return this.json(200, {
			ok: true,
			parentItemID: parentItem.id,
			attachment: this.snapshotItem(attachment)
		});
	},

	async handleRawPdfRequest(request) {
		let itemID = Number(request.headers["x-zotero-dedupe-item-id"]);
		let parentItem = Number.isInteger(itemID) && itemID > 0
			? Zotero.Items.get(itemID)
			: null;

		if (!parentItem || !parentItem.isRegularItem()) {
			throw new Error("Parent item not found: " + itemID);
		}

		let byteCount = Number(request.headers["content-length"] || 0);
		if (!byteCount) {
			throw new Error("Content-Length is required");
		}
		if (byteCount > 100 * 1024 * 1024) {
			throw new Error("PDF is too large");
		}

		let contentType = String(
			request.headers["content-type"] || "application/pdf"
		).split(";")[0].trim() || "application/pdf";
		let title = this.decodeHeaderValue(
			request.headers["x-zotero-dedupe-title"]
		) || "Full Text PDF";
		let url = this.decodeHeaderValue(
			request.headers["x-zotero-dedupe-url"]
		) || "https://example.invalid/attachment.pdf";

		let attachment = await Zotero.Attachments.importFromNetworkStream({
			url,
			stream: request.data,
			byteCount,
			contentType,
			parentItemID: parentItem.id,
			title
		});

		return this.json(200, {
			ok: true,
			raw: true,
			parentItemID: parentItem.id,
			attachment: this.snapshotItem(attachment)
		});
	},

	decodeHeaderValue(value) {
		if (!value) {
			return "";
		}
		try {
			return decodeURIComponent(String(value));
		}
		catch (_) {
			return String(value);
		}
	},

	// ---------------------------------------------------------------------
	// /dedupe/merge
	//
	// Merges duplicate items with Zotero's own merge code
	// (chrome://zotero/content/mergeItems.mjs), so notes, attachments, tags,
	// collections and relations are moved instead of lost, and the merged-away
	// items go to the Trash rather than disappearing.
	//
	// This endpoint writes, so two guards are always on:
	//   * the request must carry X-Zotero-Dedupe-Merge-Token, matching the
	//     contents of <zotero data dir>/zotero-dedupe-merge-token. The endpoint
	//     is reachable from web content, so without a secret anyone who lands
	//     you on a page could ask for merges.
	//   * dryRun defaults to true; a real merge must say "dryRun": false.
	// Zotero's mergeItems() only moves children/tags/collections/relations -
	// it never copies field values - so fillMissingFields() first copies over
	// anything the master is missing. A field the master already has is never
	// touched.
	// ---------------------------------------------------------------------
	mergeTokenFile: "zotero-dedupe-merge-token",
	mergeTokenHeader: "x-zotero-dedupe-merge-token",
	_fallbackFields: [
		"DOI", "ISBN", "ISSN", "url", "extra", "abstractNote", "title",
		"publicationTitle", "volume", "issue", "pages", "date", "language",
		"publisher", "journalAbbreviation", "shortTitle", "accessDate",
		"archiveLocation", "repository", "rights"
	],

	async readMergeToken() {
		let path = null;
		try {
			path = PathUtils.join(
				Zotero.DataDirectory.dir, this.mergeTokenFile
			);
			this._tokenPath = path;
			let text;
			if (typeof IOUtils.readUTF8 === "function") {
				text = await IOUtils.readUTF8(path);
			}
			else {
				text = new TextDecoder().decode(await IOUtils.read(path));
			}
			this._tokenError = null;
			return (text || "").trim() || null;
		}
		catch (error) {
			// Missing file and unreadable file look the same to the caller: merge
			// stays off. Keep the reason for GET /dedupe/merge.
			this._tokenError = error && error.message
				? error.message
				: String(error);
			this.log("merge token unavailable: " + this._tokenError);
			return null;
		}
	},

	checkMergeToken(request, expected) {
		let headers = request.headers || {};
		let given = headers[this.mergeTokenHeader]
			|| headers["X-Zotero-Dedupe-Merge-Token"];
		if (String(given || "").trim() !== String(expected).trim()) {
			throw new Error("Missing or wrong " + this.mergeTokenHeader);
		}
	},

	getMergeFn() {
		if (this._mergeFn) {
			return this._mergeFn;
		}
		try {
			let mod = ChromeUtils.importESModule(
				"chrome://zotero/content/mergeItems.mjs"
			);
			if (mod && typeof mod.mergeItems === "function") {
				this._mergeSource = "mergeItems.mjs";
				this._mergeFn = (item, others) => mod.mergeItems(item, others);
				return this._mergeFn;
			}
		}
		catch (error) {
			this.log("mergeItems.mjs unavailable: " + error.message);
		}
		if (Zotero.Items && typeof Zotero.Items.merge === "function") {
			this._mergeSource = "Zotero.Items.merge";
			this._mergeFn = (item, others) => Zotero.Items.merge(item, others);
		}
		return this._mergeFn;
	},

	mergeCapabilities() {
		let mergeFn = this.getMergeFn();
		return {
			ok: !!mergeFn,
			available: true,
			name: "Zotero Dedupe",
			version: this.version,
			zoteroVersion: Zotero.version,
			endpoint: this.mergePath,
			implementation: this._mergeSource || null,
			tokenConfigured: null,
			fieldSource: "itemTypeFieldsCombined + fallback"
		};
	},

	resolveMergeItem(ref, libraryID, what) {
		let value = String(ref === null || ref === undefined ? "" : ref).trim();
		if (!value) {
			throw new Error(what + " is missing");
		}
		let item = /^\d+$/.test(value)
			? Zotero.Items.get(Number(value))
			: Zotero.Items.getByLibraryAndKey(libraryID, value);
		if (!item) {
			throw new Error(what + " not found: " + value);
		}
		return item;
	},

	mergeEvidence(item, other) {
		let dois = [
			this.normalizeDoi(this.safeField(item, "DOI")),
			this.normalizeDoi(this.safeField(other, "DOI"))
		];
		if (dois[0] && dois[1] && dois[0] === dois[1]) {
			return "doi";
		}
		let titles = [
			this.normalizeTitle(this.safeField(item, "title")),
			this.normalizeTitle(this.safeField(other, "title"))
		];
		if (titles[0] && titles[1] && titles[0] === titles[1]) {
			return "title";
		}
		let years = [this.extractYear(this.safeField(item, "date")),
			this.extractYear(this.safeField(other, "date"))];
		if (years[0] && years[0] === years[1] && (titles[0] || titles[1])) {
			return "title+year";
		}
		return null;
	},

	_internalFields: new Set([
		"creators", "itemType", "key", "id", "dateAdded", "dateModified",
		"deleted", "version", "parentItem", "parentItemID", "firstCreator",
		"manualOrder", "format", "rels", "note", "annotation"
	]),
	_fieldsByType: new Map(),

	/**
	 * Field names valid for an item's type, from the schema tables
	 * (itemTypeFieldsCombined = the type's own fields plus the base mappings).
	 * Zotero.ItemTypes has no getFields() in Zotero 7-9.
	 */
	async fieldsFor(item) {
		if (this._fieldsByType.has(item.itemTypeID)) {
			return this._fieldsByType.get(item.itemTypeID);
		}
		let fields = [];
		try {
			let rows = await Zotero.DB.queryAsync(
				`SELECT fc.fieldName
				 FROM itemTypeFieldsCombined itf
				 JOIN fieldsCombined fc ON fc.fieldID = itf.fieldID
				 WHERE itf.itemTypeID = ?`,
				[item.itemTypeID]
			);
			fields = rows
				.map(row => row.fieldName)
				.filter(name => !this._internalFields.has(name));
		}
		catch (error) {
			this.log("type fields query failed: " + error.message);
		}
		if (!fields.length) {
			fields = this._fallbackFields.slice();
		}
		fields = this.unique(fields);
		this._fieldsByType.set(item.itemTypeID, fields);
		return fields;
	},

	/**
	 * Work out which values the master is missing. Pure: it only reads, because
	 * a dry run must not leave changed fields sitting on the in-memory item.
	 * Creators are only copied when the master has none: merging creator lists
	 * would risk the duplicated-author rows this library already has.
	 */
	async planFieldFill(item, others) {
		let fields = await this.fieldsFor(item);
		let plan = [];
		for (let other of others) {
			for (let field of fields) {
				let current = this.safeField(item, field);
				if (this.isBlank(current)) {
					let value = this.safeField(other, field);
					if (!this.isBlank(value)) {
						if (field === "DOI") {
							// Zotero stores a bare DOI; a copied record may hold
							// the doi.org URL instead.
							try {
								value = Zotero.Utilities.cleanDOI(value) || value;
							}
							catch (_) {}
						}
						plan.push({
							key: other.key, itemID: other.id, field, value
						});
					}
				}
			}
			let creators = [];
			try {
				creators = item.getCreators();
			}
			catch (_) {}
			if (!creators.length) {
				let source = [];
				try {
					source = other.getCreators();
				}
				catch (_) {}
				if (source.length) {
					plan.push({ key: other.key, field: "creators", count: source.length });
				}
			}
		}
		return plan;
	},

	/** Apply a planFieldFill() result; returns what was rejected by the schema. */
	applyFieldFill(item, plan) {
		let filled = [];
		let rejected = [];
		for (let step of plan) {
			try {
				if (step.field === "creators") {
					let current = [];
					try {
						current = item.getCreators();
					}
					catch (_) {}
					if (current.length) {
						rejected.push({ key: step.key, field: "creators" });
						continue;
					}
					let other = Zotero.Items.get(step.itemID);
					item.setCreators(other.getCreators());
				}
				else {
					item.setField(step.field, step.value);
				}
				filled.push({ key: step.key, field: step.field });
			}
			catch (_) {
				rejected.push({ key: step.key, field: step.field });
			}
		}
		return { filled, rejected };
	},

	isBlank(value) {
		let text = String(value === null || value === undefined ? "" : value).trim();
		return !text || text === "-";
	},

	async handleMergeRequest(request) {
		let token = await this.readMergeToken();
		let capabilities = null;
		if (request.method === "GET") {
			capabilities = this.mergeCapabilities();
			capabilities.tokenConfigured = !!token;
			if (!token) {
				capabilities.tokenPath = this._tokenPath || null;
				capabilities.tokenError = this._tokenError || null;
			}
			return this.json(200, capabilities);
		}
		if (!token) {
			throw new Error(
				"Merge is disabled: no " + this.mergeTokenFile + " in "
				+ Zotero.DataDirectory.dir
			);
		}
		this.checkMergeToken(request, token);
		let payload = this.parsePayload(request);

		if (payload.probe) {
			capabilities = this.mergeCapabilities();
			capabilities.tokenConfigured = true;
			return this.json(200, capabilities);
		}

		let dryRun = payload.dryRun === undefined ? true : !!payload.dryRun;
		let libraryID = await this.resolveLibraryID(payload.libraryID);
		let groups = payload.groups;
		if (!Array.isArray(groups) || !groups.length) {
			throw new Error("groups: [{keep: KEY, merge: [KEY, ...]}] is required");
		}
		let library = Zotero.Libraries.get(libraryID);
		if (!library || !library.editable) {
			throw new Error("The library is not editable");
		}

		let mergeFn = this.getMergeFn();
		if (!mergeFn) {
			throw new Error(
				"No merge implementation found (mergeItems.mjs / Zotero.Items.merge)"
			);
		}

		let results = [];
		let merged = 0;
		let planned = 0;
		let skipped = 0;
		for (let group of groups) {
			let entry = { dryRun };
			try {
				let target = this.resolveMergeItem(
					group.keep || group.master || group.target, libraryID, "keep"
				);
				if (target.deleted) {
					throw new Error("keep item is in the Trash: " + target.key);
				}
				if (!target.isRegularItem()) {
					throw new Error("keep item is not a regular item: " + target.key);
				}

				let refs = group.merge || group.dups || group.sources || [];
				if (!Array.isArray(refs) || !refs.length) {
					throw new Error("merge: at least one key is required");
				}

				entry.keep = this.snapshotItem(target);
				entry.merge = [];
				let approved = [];
				for (let ref of refs) {
					let other = null;
					try {
						other = this.resolveMergeItem(ref, libraryID, "merge");
					}
					catch (error) {
						entry.merge.push({ key: String(ref), why: error.message });
						continue;
					}
					let record = { key: other.key, itemID: other.id };
					if (other.id === target.id) {
						record.why = "same item as keep";
					}
					else if (other.deleted) {
						record.why = "already in the Trash";
					}
					else if (!other.isRegularItem()) {
						record.why = "not a regular item";
					}
					else if (other.libraryID !== target.libraryID) {
						record.why = "different library";
					}
					else {
						let evidence = this.mergeEvidence(target, other);
						if (!evidence) {
							record.why = "no matching DOI or title";
						}
						else {
							record.evidence = evidence;
							record.itemType = this.itemTypeName(other);
							record.typeMismatch = record.itemType
								!== this.itemTypeName(target);
							record.attachments = other.getAttachments().length;
							record.notes = other.getNotes(true).length;
							record.tags = other.getTags().length;
							approved.push(other);
						}
					}
					entry.merge.push(record);
				}

				if (!approved.length) {
					entry.why = "nothing to merge";
					skipped++;
				}
				else if (dryRun) {
					let plan = await this.planFieldFill(target, approved);
					entry.fieldsToFill = plan.map(step => ({
						from: step.key,
						field: step.field,
						value: step.field === "creators"
							? step.count + " creators"
							: String(step.value).slice(0, 120)
					}));
					entry.attachmentsAfter = target.getAttachments().length
						+ approved.reduce((n, item) => n + item.getAttachments().length, 0);
					entry.collectionsAfter = new Set([
						...target.getCollections(),
						...approved.flatMap(item => item.getCollections())
					]).size;
					entry.wouldMerge = approved.map(item => item.key);
					planned++;
				}
				else {
					let plan = await this.planFieldFill(target, approved);
					let { filled, rejected } = this.applyFieldFill(target, plan);
					if (filled.length) {
						await target.saveTx();
					}
					await mergeFn(target, approved);
					entry.filled = filled;
					entry.fieldsRejected = rejected;
					entry.merged = approved.map(item => item.key);
					entry.attachmentsAfter = target.getAttachments().length;
					merged++;
				}
			}
			catch (error) {
				skipped++;
				entry.error = error && error.message ? String(error.message) : String(error);
			}
			results.push(entry);
		}

		this.log(
			"merge " + (dryRun ? "dry run" : "applied") + ": " + groups.length
			+ " groups, " + merged + " merged, " + skipped + " skipped"
		);
		return this.json(200, {
			ok: true,
			dryRun,
			implementation: this._mergeSource,
			libraryID,
			groups: results.length,
			merged,
			planned,
			skipped,
			results
		});
	},

	base64ToBytes(value) {
		let base64 = String(value)
			.replace(/^data:[^;]+;base64,/, "")
			.replace(/\s+/g, "");
		let binary = atob(base64);
		let bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) {
			bytes[i] = binary.charCodeAt(i);
		}
		return bytes;
	},

	async checkDuplicate(item, options = {}) {
		let libraryID = await this.resolveLibraryID(options.libraryID);
		let excludeItemID = Number(options.excludeItemID || options.excludeItemId) || null;
		let target = this.buildTarget(item || {});

		let exact = await this.findExactMatch(target, libraryID, excludeItemID);
		if (exact) {
			return exact;
		}

		let fuzzy = await this.findFuzzyMatch(target, libraryID, excludeItemID);
		if (fuzzy) {
			return fuzzy;
		}

		return {
			ok: true,
			available: true,
			duplicate: false,
			libraryID,
			matchReason: null,
			matchValue: null,
			match: null,
			candidates: [],
			checkedAt: new Date().toISOString()
		};
	},

	async resolveLibraryID(libraryID) {
		if (libraryID === undefined || libraryID === null || libraryID === "") {
			return Zotero.Libraries.userLibraryID;
		}
		let id = Number(libraryID);
		let library = Number.isInteger(id) && id > 0 ? Zotero.Libraries.get(id) : false;
		if (!library) {
			throw new Error("Library not found: " + libraryID);
		}
		return library.libraryID;
	},

	buildTarget(item) {
		let title = item.title || item.titleShort || "";
		let date = item.date || item.issueDate || item.dateDecided || item.dateEnacted || "";
		let identifierText = [
			item.DOI,
			item.ISBN,
			item.ISSN,
			item.PMID,
			item.extra,
			item.url,
			item.archiveLocation,
			item.series
		].filter(Boolean).join("\n");

		return {
			title: String(title || ""),
			titleNorm: this.normalizeTitle(title),
			year: this.extractYear(date),
			firstAuthor: this.getFirstAuthor(item.creators),
			dois: this.unique([
				this.normalizeDoi(item.DOI),
				this.normalizeDoi(item.url)
			].filter(Boolean)),
			isbns: this.extractIsbns(item.ISBN),
			pmids: this.extractPmids(item.PMID + "\n" + (item.extra || "")),
			arxivIDs: this.extractArxivIDs(identifierText)
		};
	},

	async findExactMatch(target, libraryID, excludeItemID) {
		if (!target.dois.length && !target.isbns.length
				&& !target.pmids.length && !target.arxivIDs.length) {
			return null;
		}

		// Only fetch the fields needed for this item. A DOI-only check therefore
		// doesn't have to read every URL in the library.
		let fields = new Set();
		if (target.dois.length) fields.add("DOI");
		if (target.isbns.length) fields.add("ISBN");
		if (target.pmids.length) {
			fields.add("PMID");
			fields.add("extra");
		}
		if (target.arxivIDs.length) {
			fields.add("extra");
			fields.add("archiveLocation");
			fields.add("DOI");
		}

		let fieldList = Array.from(fields);
		let rows = await Zotero.DB.queryAsync(
			`SELECT i.itemID, i.key, fc.fieldName, v.value
			 FROM items i
			 JOIN itemData d ON d.itemID = i.itemID
			 JOIN itemDataValues v ON v.valueID = d.valueID
			 JOIN fieldsCombined fc ON fc.fieldID = d.fieldID
			 WHERE i.libraryID = ?
			   AND fc.fieldName IN (${fieldList.map(() => "?").join(", ")})
			   AND i.itemID NOT IN (SELECT itemID FROM deletedItems)
			   AND i.itemTypeID NOT IN (
			       SELECT itemTypeID FROM itemTypes
			       WHERE typeName IN ('attachment', 'note', 'annotation')
			   )`,
			[libraryID, ...fieldList]
		);

		// Some arXiv items only carry the ID in the URL.
		if (target.arxivIDs.length) {
			let urlRows = await Zotero.DB.queryAsync(
				`SELECT i.itemID, i.key, 'url' AS fieldName, v.value
				 FROM items i
				 JOIN itemData d ON d.itemID = i.itemID
				 JOIN itemDataValues v ON v.valueID = d.valueID
				 JOIN fieldsCombined fc ON fc.fieldID = d.fieldID
				 WHERE i.libraryID = ?
				   AND fc.fieldName = 'url'
				   AND LOWER(v.value) LIKE '%arxiv.org%'
				   AND i.itemID NOT IN (SELECT itemID FROM deletedItems)
				   AND i.itemTypeID NOT IN (
				       SELECT itemTypeID FROM itemTypes
				       WHERE typeName IN ('attachment', 'note', 'annotation')
				   )`,
				[libraryID]
			);
			rows.push(...urlRows);
		}

		let items = new Map();
		for (let row of rows) {
			let entry = items.get(row.itemID);
			if (!entry) {
				entry = { itemID: row.itemID, key: row.key, fields: {} };
				items.set(row.itemID, entry);
			}
			entry.fields[row.fieldName] = entry.fields[row.fieldName]
				? entry.fields[row.fieldName] + "\n" + row.value
				: row.value;
		}

		let checks = [
			{
				reason: "DOI",
				values: target.dois,
				extract: (entry) => this.normalizeDoi(entry.fields.DOI)
			},
			{
				reason: "ISBN",
				values: target.isbns,
				extract: (entry) => this.extractIsbns(entry.fields.ISBN),
				multiple: true
			},
			{
				reason: "PMID",
				values: target.pmids,
				extract: (entry) => this.extractPmids(
					(entry.fields.PMID || "") + "\n" + (entry.fields.extra || "")
				),
				multiple: true
			},
			{
				reason: "arXiv ID",
				values: target.arxivIDs,
				extract: (entry) => this.extractArxivIDs([
					entry.fields.extra,
					entry.fields.archiveLocation,
					entry.fields.url,
					entry.fields.DOI
				].filter(Boolean).join("\n")),
				multiple: true
			}
		];

		for (let check of checks) {
			if (!check.values.length) {
				continue;
			}
			let wanted = new Set(check.values);
			for (let entry of items.values()) {
				if (excludeItemID && entry.itemID === excludeItemID) {
					continue;
				}
				let found = check.extract(entry);
				let values = check.multiple ? found : (found ? [found] : []);
				for (let value of values) {
					if (wanted.has(value)) {
						return this.matchResult(
							entry.itemID,
							check.reason,
							value,
							1,
							libraryID
						);
					}
				}
			}
		}

		return null;
	},

	async findFuzzyMatch(target, libraryID, excludeItemID) {
		if (!target.titleNorm) {
			return null;
		}

		let tokens = target.titleNorm.split(" ")
			.filter(token => token.length >= 4 && !this.stopWords.has(token))
			.sort((a, b) => b.length - a.length);
		let token = tokens[0] || target.titleNorm.replace(/\s+/g, "").slice(0, 12);
		if (!token) {
			return null;
		}

		let rows = await Zotero.DB.queryAsync(
			`SELECT DISTINCT i.itemID, i.key
			 FROM items i
			 JOIN itemData d ON d.itemID = i.itemID
			 JOIN itemDataValues v ON v.valueID = d.valueID
			 JOIN fieldsCombined fc ON fc.fieldID = d.fieldID
			 WHERE i.libraryID = ?
			   AND fc.fieldName = 'title'
			   AND LOWER(v.value) LIKE ? ESCAPE '\\'
			   AND i.itemID NOT IN (SELECT itemID FROM deletedItems)
			   AND i.itemTypeID NOT IN (
			       SELECT itemTypeID FROM itemTypes
			       WHERE typeName IN ('attachment', 'note', 'annotation')
			   )
			 LIMIT 250`,
			[libraryID, "%" + this.escapeLike(token) + "%"]
		);

		let ids = rows
			.map(row => row.itemID)
			.filter(id => !excludeItemID || id !== excludeItemID);
		if (!ids.length) {
			return null;
		}

		let candidates = [];
		let items = await Zotero.Items.getAsync(ids);
		for (let item of (items || [])) {
			if (!item || item.deleted) {
				continue;
			}
			let title = this.safeField(item, "title");
			let titleNorm = this.normalizeTitle(title);
			if (!titleNorm) {
				continue;
			}

			let year = this.extractYear(this.safeField(item, "date"));
			let author = this.getFirstAuthor(item.getCreators());
			let titleSimilarity = this.titleSimilarity(target.titleNorm, titleNorm);
			let yearMatch = !!(target.year && year && target.year === year);
			let authorMatch = !!(target.firstAuthor && author && target.firstAuthor === author);
			let score = 0.7 * titleSimilarity
				+ 0.15 * (yearMatch ? 1 : 0)
				+ 0.15 * (authorMatch ? 1 : 0);

			candidates.push({
				item,
				titleSimilarity,
				yearMatch,
				authorMatch,
				score
			});
		}

		candidates.sort((a, b) => b.score - a.score);
		let top = candidates.slice(0, 5).map(candidate => ({
			score: Number(candidate.score.toFixed(3)),
			titleSimilarity: Number(candidate.titleSimilarity.toFixed(3)),
			yearMatch: candidate.yearMatch,
			authorMatch: candidate.authorMatch,
			item: this.snapshotItem(candidate.item)
		}));

		if (!candidates.length) {
			return null;
		}

		let best = candidates[0];
		let duplicate = best.titleSimilarity >= 0.98
			|| (best.titleSimilarity >= 0.95 && (best.yearMatch || best.authorMatch))
			|| (best.titleSimilarity >= 0.90 && best.yearMatch && best.authorMatch);

		if (!duplicate) {
			return {
				ok: true,
				available: true,
				duplicate: false,
				libraryID,
				matchReason: null,
				matchValue: null,
				match: null,
				candidates: top,
				checkedAt: new Date().toISOString()
			};
		}

		return this.matchResult(
			best.item.id,
			"fuzzy",
			this.safeField(best.item, "title"),
			best.score,
			libraryID,
			top,
			{
				titleSimilarity: best.titleSimilarity,
				yearMatch: best.yearMatch,
				authorMatch: best.authorMatch
			}
		);
	},

	matchResult(itemID, reason, value, confidence, libraryID, candidates = [], details = {}) {
		let item = Zotero.Items.get(itemID);
		let snapshot = item ? this.snapshotItem(item) : null;

		return {
			ok: true,
			available: true,
			duplicate: true,
			libraryID,
			matchReason: reason,
			matchValue: value,
			confidence,
			match: snapshot,
			candidates,
			details,
			// Backwards-compatible fields used by the first version of the extension
			existingItemKey: snapshot ? snapshot.key : null,
			existingItemID: itemID,
			existingItemTitle: snapshot ? snapshot.title : null,
			existingItemDate: snapshot ? snapshot.date : null,
			checkedAt: new Date().toISOString()
		};
	},

	snapshotItem(item) {
		let creators = [];
		try {
			creators = item.getCreators().slice(0, 5).map(creator => ({
				creatorType: creator.creatorType,
				firstName: creator.firstName || "",
				lastName: creator.lastName || creator.name || ""
			}));
		}
		catch (_) {}

		let date = this.safeField(item, "date");
		return {
			itemID: item.id,
			key: item.key,
			libraryID: item.libraryID,
			itemType: this.itemTypeName(item),
			title: this.safeField(item, "title") || item.getDisplayTitle(),
			date,
			year: this.extractYear(date),
			DOI: this.safeField(item, "DOI"),
			ISBN: this.safeField(item, "ISBN"),
			url: this.safeField(item, "url"),
			creators,
			collectionIDs: item.getCollections()
		};
	},

	itemTypeName(item) {
		try {
			return Zotero.ItemTypes.getName(item.itemTypeID);
		}
		catch (_) {
			return "";
		}
	},

	safeField(item, field) {
		try {
			let value = item.getField(field);
			return value === undefined || value === null ? "" : String(value);
		}
		catch (_) {
			return "";
		}
	},

	normalizeDoi(value) {
		if (!value) {
			return null;
		}
		let text = String(value).trim();
		try {
			let doi = Zotero.Utilities.cleanDOI(text);
			if (doi) {
				return doi.toLowerCase();
			}
		}
		catch (_) {}

		let match = text.match(/10\.[0-9]{4,9}\/[^\s"'<>]+/i);
		return match
			? match[0].replace(/[.,;:)]+$/, "").toLowerCase()
			: null;
	},

	extractIsbns(value) {
		if (!value) {
			return [];
		}

		let text = String(value)
			.toUpperCase()
			.replace(/[\u002D\u00AD\u2010-\u2015\u2212]/g, "")
			.replace(/\s+/g, "");
		let matches = text.match(/(?:97[89]\d{10}|\d{9}[\dX])/g) || [];
		let result = [];

		for (let match of matches) {
			let isbn = match;
			try {
				isbn = Zotero.Utilities.cleanISBN(match, false) || match;
			}
			catch (_) {}
			result.push(isbn);
		}

		return this.unique(result);
	},

	extractPmids(value) {
		if (!value) {
			return [];
		}

		let result = [];
		let text = String(value);
		let regex = /(?:PMID|PubMed)[:\s#]*(\d{6,9})/gi;
		let match;
		while ((match = regex.exec(text))) {
			result.push(match[1]);
		}
		if (/^\d{6,9}$/.test(text.trim())) {
			result.push(text.trim());
		}
		return this.unique(result);
	},

	extractArxivIDs(value) {
		if (!value) {
			return [];
		}

		let text = String(value);
		let result = [];
		let regex = /(?:arxiv[:\s]+|arxiv\.org\/(?:abs|pdf)\/)([a-z-]+(?:\.[a-z]{2})?\/\d{7}|\d{4}\.\d{4,5})(?:v\d+)?/gi;
		let match;
		while ((match = regex.exec(text))) {
			result.push(match[1].toLowerCase());
		}

		let doiMatch = text.match(/10\.48550\/arxiv\.([^\s]+)/i);
		if (doiMatch) {
			result.push(doiMatch[1].replace(/v\d+$/i, "").toLowerCase());
		}

		return this.unique(result);
	},

	normalizeTitle(value) {
		if (!value) {
			return "";
		}
		return String(value)
			.normalize("NFKD")
			.replace(/\p{M}/gu, "")
			.toLowerCase()
			.replace(/[^\p{L}\p{N}]+/gu, " ")
			.trim()
			.replace(/\s+/g, " ");
	},

	titleSimilarity(a, b) {
		if (!a || !b) {
			return 0;
		}
		if (a === b) {
			return 1;
		}

		let wordsA = a.split(" ").filter(word => word && !this.stopWords.has(word));
		let wordsB = b.split(" ").filter(word => word && !this.stopWords.has(word));
		if (!wordsA.length) wordsA = a.split(" ");
		if (!wordsB.length) wordsB = b.split(" ");

		if (wordsA.length > 1 || wordsB.length > 1) {
			return this.dice(new Set(wordsA), new Set(wordsB));
		}

		// For CJK titles there are no spaces, so compare character bigrams.
		return this.bigramDice(wordsA[0], wordsB[0]);
	},

	dice(setA, setB) {
		if (!setA.size || !setB.size) {
			return 0;
		}
		let intersection = 0;
		for (let value of setA) {
			if (setB.has(value)) {
				intersection++;
			}
		}
		return (2 * intersection) / (setA.size + setB.size);
	},

	bigramDice(a, b) {
		if (!a || !b) {
			return 0;
		}
		let grams = (value) => {
			let set = new Set();
			let padded = " " + value + " ";
			for (let i = 0; i < padded.length - 1; i++) {
				set.add(padded.slice(i, i + 2));
			}
			return set;
		};
		return this.dice(grams(a), grams(b));
	},

	extractYear(value) {
		if (value === undefined || value === null) {
			return null;
		}
		let match = String(value).match(/(?:^|\D)(1[5-9]\d{2}|20\d{2})(?:\D|$)/);
		return match ? Number(match[1]) : null;
	},

	getFirstAuthor(creators) {
		if (!Array.isArray(creators) || !creators.length) {
			return null;
		}
		let creator = creators.find(entry => !entry.creatorType || entry.creatorType === "author")
			|| creators[0];
		if (!creator) {
			return null;
		}
		let lastName = creator.lastName || creator.name || creator.firstName || "";
		return this.normalizePerson(lastName);
	},

	normalizePerson(value) {
		if (!value) {
			return null;
		}
		let normalized = String(value)
			.normalize("NFKD")
			.replace(/\p{M}/gu, "")
			.toLowerCase()
			.replace(/[^\p{L}\p{N}]+/gu, " ")
			.trim();
		return normalized || null;
	},

	escapeLike(value) {
		return String(value).replace(/[\\%_]/g, "\\$&");
	},

	unique(values) {
		return Array.from(new Set(values.filter(value => value !== null && value !== undefined && value !== "")));
	},

	stopWords: new Set([
		"about", "after", "again", "against", "also", "among", "and", "another",
		"are", "because", "been", "before", "being", "between", "both", "but",
		"can", "could", "does", "doing", "during", "each", "from", "further",
		"have", "having", "here", "into", "its", "itself", "more", "most",
		"other", "over", "same", "should", "some", "such", "than", "that",
		"the", "their", "them", "then", "there", "these", "they", "this",
		"those", "through", "under", "until", "very", "was", "were", "what",
		"when", "where", "which", "while", "with", "would", "your"
	])
};

function install(data, reason) {}

function startup(data, reason) {
	ZoteroDedupe.startup().catch(function (error) {
		try {
			Zotero.logError(error);
		}
		catch (_) {}
	});
}

function shutdown(data, reason) {
	if (reason === APP_SHUTDOWN) {
		return;
	}
	ZoteroDedupe.shutdown();
}

function uninstall(data, reason) {}
