import { grammar, Grammar } from "ohm-js";
import * as fse from "fs-extra";
import * as path from "path";
import { FileSystem, DocumentFolder } from "./fileSystem";
import { GMLHoverProvider } from "./hover";
import { timeUtil } from "./utils";
import {
	IConnection,
	Diagnostic,
	Hover,
	TextDocumentContentChangeEvent,
	TextDocumentPositionParams,
	WorkspaceFolder,
	DidOpenTextDocumentParams,
	CompletionParams,
	CompletionItem
} from "vscode-languageserver/lib/main";
import { DiagnosticHandler, LintPackageFactory, DiagnosticsPackage, LintPackage } from "./diagnostic";
import { Reference, IObjVar } from "./reference";
import { GMLDefinitionProvider } from "./definition";
import { GMLSignatureProvider } from "./signature";
import { GMLCompletionProvider } from "./completion";
import {
	SemanticsOption,
	CreateObjPackage,
	LanguageService,
	ResourceType,
	GMLDocs,
	GMLToolsSettings
} from "./declarations";
import { DocumentationImporter } from "./documentationImporter";

export class LangServ {
	readonly gmlGrammar: Grammar;
	public fsManager: FileSystem;
	public gmlHoverProvider: GMLHoverProvider;
	public gmlDefinitionProvider: GMLDefinitionProvider;
	public gmlSignatureProvider: GMLSignatureProvider;
	public gmlCompletionProvider: GMLCompletionProvider;
	public reference: Reference;
	public documentationImporter: DocumentationImporter;
	public timer: timeUtil;
	public userSettings: GMLToolsSettings.Config;
	private originalOpenDocuments: DidOpenTextDocumentParams[];

	constructor(public connection: IConnection) {
		this.connection = connection;
		this.originalOpenDocuments = [];
		this.gmlGrammar = grammar(
			fse.readFileSync(path.join(__dirname, path.normalize("../lib/gmlGrammar.ohm")), "utf-8")
		);

		// Create our tools:
		this.reference = new Reference();
		this.documentationImporter = new DocumentationImporter(this, this.reference);
		this.fsManager = new FileSystem(this.gmlGrammar, this);

		//#region Language Services
		this.gmlHoverProvider = new GMLHoverProvider(this.reference, this.fsManager);
		this.gmlDefinitionProvider = new GMLDefinitionProvider(this.reference, this);
		this.gmlSignatureProvider = new GMLSignatureProvider(this.reference, this.fsManager);
		this.gmlCompletionProvider = new GMLCompletionProvider(this.reference, this.fsManager);
		this.timer = new timeUtil();

		// Basic User Settings
		this.userSettings = {
			numberOfDocumentationSentences: 1,
			preferredSpellings: GMLToolsSettings.SpellingSettings.american
		};
		//#endregion
	}

	//#region Init
	public async workspaceBegin(workspaceFolder: WorkspaceFolder[]) {
		// Let the FileSystem do its index thing...
		await this.fsManager.initialWorkspaceFolders(workspaceFolder);

		// Check or Create the Manual:
		let ourManual: GMLDocs.DocFile | null;
		let cacheManual = false;
		if ((await this.fsManager.isFileCached("gmlDocs.json")) == false) {
			ourManual = await this.documentationImporter.createManual();
			cacheManual = true;
		} else {
			ourManual = JSON.parse(await this.fsManager.getCachedFileText("gmlDocs.json", "utf-8"));
		}

		// If we have a manual, load it into memory:
		if (ourManual) {
			// Load our Manual into Memory
			this.reference.indexGMLDocs(ourManual);

			// Cache the Manual:
			if (cacheManual) {
				this.fsManager.setCachedFileText("gmlDocs.json", JSON.stringify(ourManual, null, 4));
			}
		}

		// Get our Configuration
		this.userSettings = await this.connection.workspace.getConfiguration({
			section: "gml-tools"
		});

		// Assign our settings, per setting:
		this.gmlHoverProvider.numberOfSentences = this.userSettings.numberOfDocumentationSentences;
	}

	public async initialIndex() {
		await this.fsManager.initialParseYYP();
	}

	public async findNewSettings(): Promise<{ [prop: string]: string }> {
		if (!this.userSettings) return {};
		// Get our Settings:
		const newSettings = await this.connection.workspace.getConfiguration({
			section: "gml-tools"
		});

		// Iterate over to find our changed settings:
		const ourSettings = Object.keys(newSettings);
		let changedSettings: any = {};

		for (const thisSetting of ourSettings) {
			if (JSON.stringify(newSettings[thisSetting]) != JSON.stringify(this.userSettings[thisSetting])) {
				changedSettings[thisSetting] = newSettings[thisSetting];
			}
		}

		// Commit our changed Configs
		return changedSettings;
	}

	public async updateSettings(changedSettings: { [key: string]: any }) {
		const newSettings = Object.keys(changedSettings);

		// Iterate on the settings
		for (const thisSetting of newSettings) {
			if (thisSetting == "preferredSpellings") {
				if (
					changedSettings[thisSetting] == GMLToolsSettings.SpellingSettings.american ||
					changedSettings[thisSetting] == GMLToolsSettings.SpellingSettings.british ||
					changedSettings[thisSetting] == GMLToolsSettings.SpellingSettings.noPref
				) {
					this.userSettings.preferredSpellings = changedSettings[thisSetting];

					this.connection.window.showWarningMessage("Please Restart VSCode for Setting to Take Effect.");

					try {
						this.fsManager.deletedCachedFile("gmlDocs.json");
					} catch (err) {
						throw err;
					}
				}
			}

			if (thisSetting == "numberOfDocumentationSentences") {
				this.userSettings.numberOfDocumentationSentences = changedSettings[thisSetting];
				// Assign our settings, per setting:
				this.gmlHoverProvider.numberOfSentences = this.userSettings.numberOfDocumentationSentences;
			}
		}
	}

	private isServerReady() {
		return this.fsManager.indexComplete;
	}
	//#endregion

	//#region Text Events
	public async openTextDocument(params: DidOpenTextDocumentParams) {
		// Commit to open Q if indexing still...
		if (this.isServerReady() == false) {
			this.originalOpenDocuments.push(params);
			return;
		}

		const uri = params.textDocument.uri;
		const text = params.textDocument.text;

		const thisDiagnostic = await this.fsManager.getDiagnosticHandler(uri);
		await thisDiagnostic.setInput(text);
		this.fsManager.addDocument(uri, text);
		this.fsManager.addOpenDocument(uri);

		const finalDiagnosticPackage = await this.lint(thisDiagnostic, SemanticsOption.All);

		// Send Final Diagnostics
		this.connection.sendDiagnostics(DiagnosticsPackage.create(uri, finalDiagnosticPackage));
	}

	public async changedTextDocument(uri: string, contentChanges: Array<TextDocumentContentChangeEvent>) {
		if (this.isServerReady() == false) return;

		// Find our Diagnostic:
		const thisDiagnostic = await this.fsManager.getDiagnosticHandler(uri);

		// Set our Input: TODO make this server actually incremental.
		for (const contentChange of contentChanges) {
			await thisDiagnostic.setInput(contentChange.text);
		}

		this.fsManager.addDocument(uri, thisDiagnostic.getInput());
		const finalDiagnosticPackage = await this.lint(thisDiagnostic, SemanticsOption.All);
		// Send Final Diagnostics
		this.connection.sendDiagnostics(DiagnosticsPackage.create(uri, finalDiagnosticPackage));
	}
	//#endregion

	//#region Diagnostics
	public async initLint(thisDiagnostic: DiagnosticHandler): Promise<LintPackage> {
		// Set up:
		let lintPackage = LintPackageFactory.createBlank();

		return lintPackage;
	}

	public async getMatchResultsPackage(thisDiagnostic: DiagnosticHandler, lintPackage: LintPackage) {
		if (thisDiagnostic.match() == false) {
			await thisDiagnostic.primarySyntaxLint(lintPackage);

			return lintPackage.getDiagnostics();
		} else {
			// get our Signature token list (we do this in Primary Syntax on success...)
			await thisDiagnostic.createSignatureTokenListGoodMatch();

			// This is a blank diagnostic. TODO: make the MatchResultsPackage creation less absurd.
			lintPackage.setMatchResultsPackage([
				{
					indexRange: { startIndex: 0 },
					matchResult: thisDiagnostic.getMatchResult()
				}
			]);
			return lintPackage.getDiagnostics();
		}
	}

	public async lint(thisDiagnostic: DiagnosticHandler, bit: SemanticsOption) {
		let lintPack = await this.initLint(thisDiagnostic);
		this.timer.setTimeFast();
		const initDiagnostics = await this.getMatchResultsPackage(thisDiagnostic, lintPack);
		console.log("Our normal syntax lint took " + this.timer.timeDifferenceNowNice());
		this.timer.setTimeFast();
		const semDiagnostics = await this.runSemantics(thisDiagnostic, lintPack, bit);
		console.log("Our Semantics took " + this.timer.timeDifferenceNowNice());

		return initDiagnostics.concat(semDiagnostics);
	}

	public async runSemantics(thisDiagnostic: DiagnosticHandler, lintPackage: LintPackage, bit: SemanticsOption) {
		let diagnosticArray: Diagnostic[] = [];

		// Semantic Lint
		if ((bit & SemanticsOption.Function) == SemanticsOption.Function) {
			diagnosticArray = diagnosticArray.concat(
				await this.semanticLint(thisDiagnostic, lintPackage, diagnosticArray)
			);
		}

		// Variable Index
		if ((bit & SemanticsOption.Variable) == SemanticsOption.Variable) {
			await this.semanticVariableIndex(thisDiagnostic, lintPackage);
		}

		// Enums & Macros
		if ((bit & SemanticsOption.EnumsAndMacros) == SemanticsOption.EnumsAndMacros) {
			await this.semanticEnumsAndMacros(thisDiagnostic, lintPackage);
		}

		// JSDOC
		if ((bit & SemanticsOption.JavaDoc) == SemanticsOption.JavaDoc) {
			const docInfo = await this.fsManager.getDocumentFolder(thisDiagnostic.getURI);
			if (docInfo && docInfo.type) {
				await this.semanticJSDOC(thisDiagnostic, lintPackage, docInfo);
			}
		}

		return diagnosticArray;
	}

	public async semanticLint(
		thisDiagnostic: DiagnosticHandler,
		lintPackage: LintPackage,
		diagnosticArray: Diagnostic[]
	) {
		// Run Semantics on Existing MatchResults.
		const theseMatchResults = lintPackage.getMatchResults();
		if (theseMatchResults) {
			await thisDiagnostic.runSemanticLintOperation(theseMatchResults);
		}
		diagnosticArray = diagnosticArray.concat(thisDiagnostic.popSemanticDiagnostics());

		return diagnosticArray;
	}

	public async semanticVariableIndex(thisDiagnostic: DiagnosticHandler, lintPackage: LintPackage) {
		const thisURI = thisDiagnostic.getURI;
		const theseMatchResults = lintPackage.getMatchResults();
		if (!theseMatchResults) return;
		const varPackage = await thisDiagnostic.runSemanticIndexVariableOperation(theseMatchResults);
		const URIInformation = await this.fsManager.getDocumentFolder(thisURI);

		// Instance Variables
		if (URIInformation) {
			if (URIInformation.type == ResourceType.Object) {
				// Figure out the missing Variables
				const ourVariablesWeShouldHaveFound = this.reference.getAllVariablesAtURI(thisURI);
				let variablesNotFound: IObjVar[] = [];

				if (ourVariablesWeShouldHaveFound) {
					for (const varShouldHaveFound of ourVariablesWeShouldHaveFound) {
						// Loop here cause I don't get array.prototype.filter cause I'm a fool:
						let found = false;
						for (const varFound of varPackage.variables) {
							if (varFound.name == varShouldHaveFound.variable) {
								found = true;
								break;
							}
						}

						if (found == false) {
							variablesNotFound.push(varShouldHaveFound);
						}
					}
				}

				this.reference.clearTheseVariablesAtURI(thisURI, variablesNotFound);
				this.reference.addAllVariablesToObject(URIInformation.name, thisURI, varPackage);
			}
		}

		// Local Variables
		this.reference.localAddVariables(thisURI, varPackage.localVariables);
	}

	public async semanticEnumsAndMacros(thisDiagnostic: DiagnosticHandler, lintPackage: LintPackage) {
		const matches = lintPackage.getMatchResults();
		if (!matches) return;
		const enumsAndMacros = await thisDiagnostic.runSemanticEnumsAndMacros(matches);
		const ourEnumsThisCycle = enumsAndMacros[0];
		const ourMacosThisCycle = enumsAndMacros[1];

		const ourURI = thisDiagnostic.getURI;

		// Enum Work
		const supposedEnums = this.reference.getAllEnumsAtURI(ourURI);
		let enumsNotFound = [];

		if (ourEnumsThisCycle.length > 0) {
			for (const thisEnum of supposedEnums) {
				if (ourEnumsThisCycle.includes(thisEnum) == false) {
					enumsNotFound.push(thisEnum);
				}
			}
		} else {
			enumsNotFound = supposedEnums;
		}

		// Clear out our missing Enums:
		if (enumsNotFound.length > 0) {
			this.reference.clearTheseEnumsAtThisURI(enumsNotFound, ourURI);
		}

		// Macro Work
		const supposedMacros = this.reference.getAllMacrosAtURI(ourURI);
		let macrosNotFound = [];

		if (ourMacosThisCycle.length > 0) {
			for (const thisMacro of supposedMacros) {
				let found = false;
				for (const thisFoundMacro of ourMacosThisCycle) {
					if (thisFoundMacro.macroName == thisMacro) {
						found = true;
						break;
					}
				}
				if (found == false) {
					macrosNotFound.push(thisMacro);
				}
			}
		} else {
			macrosNotFound = supposedMacros;
		}

		// Clear our missing Macros
		if (macrosNotFound.length > 0) {
			this.reference.clearTheseMacrosAtURI(macrosNotFound, ourURI);
		}
	}

	public async semanticJSDOC(thisDiagnostic: DiagnosticHandler, lintPackage: LintPackage, docInfo: DocumentFolder) {
		const matchResults = lintPackage.getMatchResults();
		if (!matchResults) return;
		const ourJSDOC = await thisDiagnostic.runSemanticJSDOC(matchResults, docInfo.name);

		this.reference.scriptAddJSDOC(docInfo.name, ourJSDOC);
	}
	//#endregion

	//#region Type Service Calls
	public async hoverOnHover(params: TextDocumentPositionParams): Promise<Hover | null> {
		if (this.isServerReady() == false) return null;
		return await this.gmlHoverProvider.provideHover(params);
	}

	public onDefinitionRequest(params: TextDocumentPositionParams) {
		if (this.isServerReady() == false) return null;
		return this.gmlDefinitionProvider.onDefinitionRequest(params);
	}

	public async onSignatureRequest(params: TextDocumentPositionParams) {
		if (this.isServerReady() == false) return null;
		return await this.gmlSignatureProvider.onSignatureRequest(params);
	}

	public onCompletionRequest(params: CompletionParams) {
		if (this.isServerReady() == false) return null;
		return this.gmlCompletionProvider.onCompletionRequest(params);
	}

	public async onCompletionResolveRequest(params: CompletionItem) {
		if (this.isServerReady() == false) return params;
		return await this.gmlCompletionProvider.onCompletionResolveRequest(params);
	}

	//#endregion

	//#region Commands
	public async createObject(objectPackage: CreateObjPackage) {
		console.log("DON'T LET THIS TRHOUGH DINGUS");
		return;
		// // Basic Conversions straight here:
		// if (typeof objectPackage.objectEvents == "string") {
		// 	objectPackage.objectEvents = objectPackage.objectEvents.toLowerCase().split(",");
		// 	objectPackage.objectEvents = objectPackage.objectEvents.map(function(x) {
		// 		return x.trim();
		// 	});
		// }

		// objectPackage.objectName = objectPackage.objectName.trim();

		// // Valid name
		// if (this.isValidResourceName(objectPackage.objectName) == false) {
		// 	this.connection.window.showErrorMessage(
		// 		"Invalid object name given. Resource names should only contain 0-9, a-z, A-Z, or _, and they should not start with 0-9."
		// 	);
		// 	return null;
		// }

		// // Check for duplicate resources:
		// if (this.resourceExistsAlready(objectPackage.objectName)) {
		// 	this.connection.window.showErrorMessage("Invalid object name given. Resource already exists.");
		// 	return null;
		// }

		// // If we made it here, send to the FS for the rest.
		// const ourGMLFilePath = await this.fsManager.createObject(objectPackage);
		// if (ourGMLFilePath) {
		// 	this.connection.sendNotification("goToURI", ourGMLFilePath);
		// }
	}

	public async createScript(scriptName: string) {
		console.log("WE MADE IT HERE GET RID OF THIS DON'T SHIP IT.");
		return;
		// Basic Check
		if (this.isValidResourceName(scriptName) == false) {
			this.connection.window.showErrorMessage(
				"Invalid object name given. Resource names should only contain 0-9, a-z, A-Z, or _, and they should not start with 0-9."
			);
			return null;
		}

		// Check for duplicate resources:
		if (this.resourceExistsAlready(scriptName)) {
			this.connection.window.showErrorMessage("Invalid script name given. Resource already exists.");
			return null;
		}

		const ourGMLFilePath = await this.fsManager.createScript(scriptName);
		if (ourGMLFilePath) {
			this.connection.sendNotification("goToURI", ourGMLFilePath);
		}
	}

	public async addEvents(eventsPackage: { uri: string; events: string }) {
		let eventsArray = eventsPackage.events.toLowerCase().split(",");
		eventsArray = eventsArray.map(function(x) {
			return x.trim();
		});

		// Send it to fs_manager
		const ourGMLFilePath = await this.fsManager.addEvents({
			events: eventsArray,
			uri: eventsPackage.uri
		});
		if (ourGMLFilePath) {
			this.connection.sendNotification("goToURI", ourGMLFilePath);
		}
	}

	public beginCompile(type: "test" | "zip" | "installer", yyc: boolean, output?: string) {
		return this.fsManager.compile(type, yyc, output);
	}

	public async forceReIndex() {
		this.connection.window.showWarningMessage("Reindexing...Type services may be limited until index is complete.");
		this.reference.clearAllData();
		await this.fsManager.clearAllData();
	}

	//#endregion

	//#region Utilities
	public requestLanguageServiceHandler(thisHandle: LanguageService): any {
		switch (thisHandle) {
			case LanguageService.FileSystem:
				return this.fsManager;

			case LanguageService.GMLCompletionProvider:
				return this.gmlCompletionProvider;

			case LanguageService.GMLDefinitionProvider:
				return this.gmlDefinitionProvider;

			case LanguageService.GMLHoverProvider:
				return this.gmlHoverProvider;

			case LanguageService.GMLSignatureProvider:
				return this.gmlSignatureProvider;

			case LanguageService.Reference:
				return this.reference;
		}
	}

	private isValidResourceName(name: string) {
		return /^[a-z_]+[a-z0-9_]*$/i.test(name);
	}

	private resourceExistsAlready(name: string) {
		return this.reference.resourceExists(name);
	}

	//#endregion
}
