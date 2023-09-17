import {
	App,
	SuggestModal,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	setIcon,
	loadPdfJs
} from "obsidian";

const hash = require("hash.js");

// We should be able to import it differently, but I am tired of fighting with esbuild
import * as pgml from "pgml";

interface SuperSearchSettings {
	databaseURL: string;
	excludedDirectories: string[];
	lastEmbeddedingTime: number;
	textEmbedBatchSize: number;
	pdfConcurrentProcessSize: number;
	pdfEmbedBatchSize: number;
	splitterName: string;
	splitterParameters: string;
	modelName: string;
	modelEmbeddingParameters: string;
	modelSearchParameters: string;
}

const DEFAULT_SETTINGS: SuperSearchSettings = {
	databaseURL: "",
	excludedDirectories: [],
	lastEmbeddedingTime: 0,
	pdfConcurrentProcessSize: 1,
	textEmbedBatchSize: 10,
	pdfEmbedBatchSize: 10,
	splitterName: "recursive_character",
	splitterParameters: '{"chunk_size": 1500, "chunk_overlap": 40}',
	modelName: "hkunlp/instructor-xl",
	modelEmbeddingParameters:
		'{"instruction": "Represent the Wikipedia document for retrieval: "}',
	modelSearchParameters:
		'{"instruction": "Represent the Wikipedia question for retrieving supporting documents: "}',
};

export default class SuperSearch extends Plugin {
	settings: SuperSearchSettings;
	statusBarItemEl: HTMLElement;

	// Need to fix this typing issue in the pgml module
	collection: any;
	pipeline: any;

	async onload() {
		await this.loadSettings();

		// Remove this later
		this.settings.lastEmbeddedingTime = 0;
		this.saveSettings();

		// Need to figure out how to get the old name from the file
		// this.app.vault.on("rename", (f: TAbstractFile) => {
		// 	if (this.settings.excludedDirectories.contains(f.path)) return;
		// 	if (!(f instanceof TFile)) return;
		// 	const file = <TFile>f;
		// 	this.collection
		// 		.delete_documents({
		// 			metadata: { id: { $eq: file.path } },
		// 		})
		// 		.then(() => {
		// 			console.log(`File deleted: ${ file.path }`);
		// 		})
		// 		.catch((e: any) => {
		// 			console.log(
		// 				`Error deleting file: ${ file.path } - Error: `,
		// 				e,
		// 			);
		// 		});
		// });

		// This adds a status bar item to the bottom of the app. Does not work on mobile apps.
		this.statusBarItemEl = this.addStatusBarItem();

		this.app.workspace.on("file-open", (file) => {
			if(!file) return;
			const collection = pgml.newCollection(this.app.vault.getName(), this.settings.databaseURL);	
			collection.get_documents({
				limit: 1,
				filter: {
					metadata: {
						id: {
							$eq: file.path
						}
					}
				}
			}).then((document: any) => {
				if (document.length > 0 && document[0].created_at >= Math.floor(file.stat.mtime / 1000)) {
					setIcon(this.statusBarItemEl, "file-check");
				} else {
					setIcon(this.statusBarItemEl, "file-x");
				}
			}).catch((e: any) => {
				console.log("Error checking document status", e);
			});
		});

		this.addCommand({
			id: "super-embed",
			name: "Super Embed",
			checkCallback: (checking: boolean): boolean | void => {
				if (!this.settings.databaseURL) return false;
				if (checking) return true;
				this.statusBarItemEl.setText("🔮 [AI] Embedding...");

				let timestamp = Date.now();
				const files = this.app.vault
					.getFiles()
					.filter(
						(f) =>
							!this.settings.excludedDirectories.contains(
								f.path,
							) &&
							f.stat.mtime > this.settings.lastEmbeddedingTime,
					);
				this.embedFiles(files)
					.then(() => {
						this.statusBarItemEl.setText("🔮 [AI] Embedded");
						this.settings.lastEmbeddedingTime = timestamp;
						// this.saveSettings().catch((e) => {
						// 	console.log("Error saving settings", e);
						// });
						console.log("Files embedded");
					})
					.catch((e) => {
						console.log("Erorr embedding files: ", e);
					});
			},
		});

		// This adds a simple command that can be triggered anywhere
		this.addCommand({
			id: "super-search",
			name: "Super Search",
			checkCallback: (checking: boolean): boolean | void => {
				if (!this.settings.databaseURL) return false;
				if (checking) return true;
				const collection = pgml.newCollection(
					this.app.vault.getName(),
					this.settings.databaseURL,
				);
				const pipeline = pgml.newPipeline(this.getPipelineName());
				new SuperSearchModal(this.app, collection, pipeline).open();
			},
		});

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new SuperSearchSettingTab(this.app, this));
	}

	getPipelineName(): string {
		return hash
			.sha256()
			.update(
				this.settings.modelName +
					this.settings.modelEmbeddingParameters +
					this.settings.splitterName +
					this.settings.splitterParameters,
			)
			.digest("hex");
	}

	async embedFiles(files: TFile[]): Promise<void> {
		// Create the Pipeline
		let model;
		if (this.settings.modelEmbeddingParameters) {
			model = pgml.newModel(
				this.settings.modelName,
				"pgml",
				JSON.parse(this.settings.modelEmbeddingParameters),
			);
		} else {
			model = pgml.newModel(this.settings.modelName);
		}
		let splitter;
		if (this.settings.splitterParameters) {
			splitter = pgml.newSplitter(
				this.settings.splitterName,
				JSON.parse(this.settings.splitterParameters),
			);
		} else {
			splitter = pgml.newSplitter(this.settings.splitterName);
		}

		const pipeline = pgml.newPipeline(
			this.getPipelineName(),
			model,
			splitter,
		);

		// Create the Collection
		const collection = pgml.newCollection(
			this.app.vault.getName(),
			this.settings.databaseURL,
		);

		// Add the pipeline to the Collection
		await collection.add_pipeline(pipeline);

		let pdf_files = files.filter((f) => f.extension == "pdf");
		let text_files = files.filter(
			(f) => f.extension == "md" || f.extension == "txt",
		);
		await this.embedTextFiles(text_files, collection);
		await this.embedPDFFiles(pdf_files, collection);
	}

	async embedTextFiles(files: TFile[], collection: any): Promise<void> {
		for (
			let i = 0;
			i < files.length;
			i += this.settings.textEmbedBatchSize
		) {
			const documents: {
				id: string;
				text: string;
				path: string;
				type: string;
			}[] = [];
			for (
				let q = i;
				q <
				Math.min(i + this.settings.textEmbedBatchSize, files.length);
				q += 1
			) {
				const content = await this.app.vault.cachedRead(files[q]);
				documents.push({
					id: files[q].path,
					text: content,
					path: files[q].path,
					type: "text",
				});
			}
			await collection.upsert_documents(documents);
		}
	}

	async embedPDFFiles(files: TFile[], collection: any): Promise<void> {
		let pdfjsLib = await loadPdfJs();
		for (
			let i = 0;
			i < files.length;
			i += this.settings.pdfConcurrentProcessSize
		) {
			const promises = [];
			for (
				let q = i;
				q <
				Math.min(
					i + this.settings.pdfConcurrentProcessSize,
					files.length,
				);
				q += 1
			) {
				promises.push(this.embedPDFFile(files[q], collection, pdfjsLib));
			}
			await Promise.all(promises);
		}
	}

	async embedPDFFile(file: TFile, collection: any, pdfjsLib: any): Promise<void> {
		let buffer = await this.app.vault.readBinary(file);
		let doc = await pdfjsLib.getDocument({ data: buffer }).promise;
		let pageIndex = 1;
		let documents: {
			id: string;
			text: string;
			path: string;
			page: number;
			type: string;
		}[] = [];
		while (true) {
			try {
				let page = await doc.getPage(pageIndex);
				let content = await page.getTextContent();
				if (content.items.length == 0) {
					pageIndex += 1;
					continue;
				}
				let text = content.items.map((item: any) => item.str).join("");
				documents.push({
					id: `${file.path}--${pageIndex}`,
					text,
					page: pageIndex,
					type: "pdf",
					path: file.path,
				});
			} catch (e) {
				// If we get an invalid page request, we have reached the end of the pdf
				if (e.message == "Invalid page request.") {
					await collection.upsert_documents(documents);
					break;
				} else {
					throw e;
				}
			}
			if (documents.length == this.settings.pdfEmbedBatchSize) {
				await collection.upsert_documents(documents);
				documents = [];
			}
			pageIndex += 1;
		}
	}

	onunload() {}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData(),
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

interface SearchResult {
	score: number;
	content: string;
	path: string;
	type: string;
	page?: number;
}

class SuperSearchModal extends SuggestModal<SearchResult> {
	collection: any;
	pipeline: any;
	typeId: number;

	constructor(app: App, collection: any, pipeline: any) {
		super(app);
		this.typeId = 0;
		this.collection = collection;
		this.pipeline = pipeline;

		const instructions = [
			["↑↓", "to navigate"],
			["↵", "to open"],
			["esc", "to dismiss"],
		];
		const modalInstructionsHTML = this.modalEl.createEl("div", {
			cls: "prompt-instructions",
		});
		for (const instruction of instructions) {
			const modalInstructionHTML = modalInstructionsHTML.createDiv({
				cls: "prompt-instruction",
			});
			modalInstructionHTML.createSpan({
				cls: "prompt-instruction-command",
				text: instruction[0],
			});
			modalInstructionHTML.createSpan({ text: instruction[1] });
		}

		this.setPlaceholder("Enter query to super search!");
	}

	async getSuggestions(query: string): Promise<SearchResult[]> {
		if (!query) return [];
		this.typeId += 1;
		const id = this.typeId;
		await sleep(350);
		if (this.typeId != id) return [];

		try {
			let results: [number, string, any][] = await this.collection
				.query()
				.vector_recall(query, this.pipeline)
				.limit(10)
				.fetch_all();
			return results.map((r) => {
				return {
					score: r[0],
					content: r[1],
					path: r[2].path,
					page: r[2].page,
					type: r[2].type,
				};
			});
		} catch (e) {
			console.log(`Error during Super Search ${e.message}`);
			return [];
		}
	}

	renderSuggestion(result: SearchResult, el: HTMLElement) {
		el.classList.add("prompt-suggestion-item");
		el.createEl("div", {
			cls: "prompt-suggestion-header",
			text: `${result.path}(${result.score.toFixed(3)})`,
		});
		el.createEl("div", {
			cls: "prompt-suggestion-content",
			text: truncateString(removeMarkdown(result.content), 200),
		});
	}

	onChooseSuggestion(result: SearchResult, _evt: MouseEvent | KeyboardEvent) {
		const leaf = this.app.workspace.getLeaf();
		const files = this.app.vault.getFiles();
		const selected = files.find((file) => file.path === result.path);
		if (selected) leaf.openFile(selected);
	}
}

class SuperSearchSettingTab extends PluginSettingTab {
	plugin: SuperSearch;

	constructor(app: App, plugin: SuperSearch) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName("Database Connection URL")
			.setDesc(
				"The connection URL for the PostgreSQL database used for storing embeddings and searching",
			)
			.addText((text) =>
				text
					.setPlaceholder("postgres://127.0.0.1:5432/vault")
					.setValue(this.plugin.settings.databaseURL)
					.onChange(async (value) => {
						this.plugin.settings.databaseURL = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Excluded Directories")
			.setDesc(
				"Comma seperated list of directories to exclude embedding and searching over",
			)
			.addTextArea((text) =>
				text
					.setPlaceholder("path1, path2, path3")
					.setValue(
						this.plugin.settings.excludedDirectories.join(", "),
					)
					.onChange(async (value) => {
						this.plugin.settings.excludedDirectories = value
							.split(",")
							.map((path) => path.trim());
						await this.plugin.saveSettings();
					}),
			);

		[
			[
				"splitterName",
				"Splitter Name",
				"The splitter to use for splitting documents",
			],
			["modelName", "Model Name", "The model to use for embedding"],
		].forEach(
			(setting: [keyof typeof this.plugin.settings, string, string]) => {
				new Setting(containerEl)
					.setName(setting[1])
					.setDesc(setting[2])
					.addText((text) =>
						text
							.setValue(<string>this.plugin.settings[setting[0]])
							// Not really sure what is going on with the typing here
							.onChange(async (value: never) => {
								this.plugin.settings[setting[0]] = value;
								await this.plugin.saveSettings();
							}),
					);
			},
		);

		[
			[
				"splitterParameters",
				"Splitter Parameters",
				"Parameters for the splitter",
			],
			[
				"modelEmbeddingParameters",
				"Model Embedding Parameters",
				"Parameters used for embedding during embedding",
			],
			[
				"modelSearchParameters",
				"Model Search Parameters",
				"Parameters used for embedding during search",
			],
		].forEach(
			(setting: [keyof typeof this.plugin.settings, string, string]) => {
				new Setting(containerEl)
					.setName(setting[1])
					.setDesc(setting[2])
					.addTextArea((text) =>
						text
							.setValue(<string>this.plugin.settings[setting[0]])
							// Not really sure what is going on with the typing here
							.onChange(async (value: never) => {
								this.plugin.settings[setting[0]] = value;
								await this.plugin.saveSettings();
							}),
					);
			},
		);
	}
}

const truncateString = (str: string, maxLength: number): string => {
	if (str.length <= maxLength) {
		return str;
	}
	return str.slice(0, maxLength) + "...";
};

const removeMarkdown = (text: string): string => {
	// Remove emphasis (e.g., *text*, _text_)
	text = text.replace(/[*_]{1,2}([^*_]+)[*_]{1,2}/g, "$1");

	// Remove headers (e.g., # Header)
	text = text.replace(/#{1,6}\s*(.*)/g, "$1");

	// Remove links (e.g., [Link](url))
	text = text.replace(/\[([^[\]]+)\]\([^()]+\)/g, "$1");

	// Remove images (e.g., ![Alt Text](url))
	text = text.replace(/!\[([^[\]]+)\]\([^()]+\)/g, "");

	// Remove code blocks (e.g., ```code```)
	text = text.replace(/`{ 3}([^ `]+)`{ 3} /g, "");

	// Remove inline code (e.g., `code`)
	text = text.replace(/`([^`]+)`/g, "$1");

	// Remove lists (e.g., * List Item)
	text = text.replace(/^[\s]*[\-*+]\s+(.*)/gm, "$1");

	// Remove blockquotes (e.g., > Quote)
	text = text.replace(/^>\s+(.*)/gm, "$1");

	// Remove horizontal rules (e.g., ---)
	text = text.replace(/^-{3,}/gm, "");

	// Remove strikethrough (e.g., ~~text~~)
	text = text.replace(/~~([^~]+)~~/g, "$1");

	// Remove wikilinks (e.g., [[Link]])
	text = text.replace(/\[\[([^\]]+)\]\]/g, "$1");

	return text;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
