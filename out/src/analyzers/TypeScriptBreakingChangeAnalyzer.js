"use strict";
/**
 * TypeScript Breaking Change Analyzer
 *
 * Uses TypeScript compiler API to detect breaking changes in TypeScript/TSX files
 * by comparing API snapshots before and after changes.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TypeScriptBreakingChangeAnalyzer = void 0;
const ts = __importStar(require("typescript"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
/* ============================
 * Main Analyzer Class
 * ============================ */
class TypeScriptBreakingChangeAnalyzer {
    constructor() {
        this.tempDirs = [];
    }
    /**
     * Analyze breaking changes between before and after content
     */
    async analyzeBreakingChanges(filePath, beforeContent, afterContent, projectRoot, tsconfigPath) {
        try {
            // Find or create tsconfig
            const resolvedTsconfig = tsconfigPath || this.findTsconfig(projectRoot, filePath);
            if (!resolvedTsconfig) {
                console.log(`[TSBreakingChange] No tsconfig found for ${filePath}, skipping TypeScript analysis`);
                return [];
            }
            // Create programs for before and after
            const beforeCtx = await this.createProgramFromContent(filePath, beforeContent, projectRoot, resolvedTsconfig);
            const afterCtx = await this.createProgramFromContent(filePath, afterContent, projectRoot, resolvedTsconfig);
            if (!beforeCtx || !afterCtx) {
                return [];
            }
            // Build snapshots
            const beforeSnap = this.buildModuleSnapshot(beforeCtx, filePath);
            const afterSnap = this.buildModuleSnapshot(afterCtx, filePath);
            console.log(`[TSBreakingChange] Before exports: ${beforeSnap.exports.size}, After exports: ${afterSnap.exports.size}`);
            console.log(`[TSBreakingChange] Before export names: ${Array.from(beforeSnap.exports.keys()).join(', ')}`);
            console.log(`[TSBreakingChange] After export names: ${Array.from(afterSnap.exports.keys()).join(', ')}`);
            // Diff snapshots
            const breakingChanges = this.diffSnapshots(beforeSnap, afterSnap);
            console.log(`[TSBreakingChange] Diff found ${breakingChanges.length} breaking changes`);
            // Resolve impacts using TypeScript checker
            if (breakingChanges.length > 0) {
                await this.resolveImpacts(breakingChanges, afterCtx, projectRoot, filePath);
            }
            // Cleanup temp directories
            this.cleanup();
            return breakingChanges;
        }
        catch (error) {
            console.error(`[TSBreakingChange] Error analyzing ${filePath}:`, error);
            this.cleanup();
            return [];
        }
    }
    /**
     * Create TypeScript program from content (for baseline)
     */
    async createProgramFromContent(filePath, content, projectRoot, tsconfigPath) {
        try {
            // Create temp directory for this file
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-analyzer-'));
            this.tempDirs.push(tempDir);
            // Write content to temp file
            const tempFilePath = path.join(tempDir, path.basename(filePath));
            const tempDirPath = path.dirname(tempFilePath);
            fs.mkdirSync(tempDirPath, { recursive: true });
            fs.writeFileSync(tempFilePath, content, 'utf8');
            // Read and parse tsconfig
            const configText = fs.readFileSync(tsconfigPath, 'utf8');
            const { config } = ts.parseConfigFileTextToJson(tsconfigPath, configText);
            const configParse = ts.parseJsonConfigFileContent(config, ts.sys, path.dirname(tsconfigPath), undefined, tsconfigPath);
            // Add temp file to program
            const rootNames = [...configParse.fileNames, tempFilePath];
            // Adjust paths to include temp directory structure
            const options = {
                ...configParse.options,
                rootDir: projectRoot,
            };
            const program = ts.createProgram({
                rootNames,
                options,
            });
            return {
                program,
                checker: program.getTypeChecker(),
                tempDir
            };
        }
        catch (error) {
            console.error(`[TSBreakingChange] Error creating program:`, error);
            return null;
        }
    }
    /**
     * Find tsconfig.json for a file
     */
    findTsconfig(startPath, filePath) {
        let current = path.dirname(filePath);
        const root = path.parse(current).root;
        while (current !== root) {
            const tsconfigPath = path.join(current, 'tsconfig.json');
            if (fs.existsSync(tsconfigPath)) {
                return tsconfigPath;
            }
            current = path.dirname(current);
        }
        return null;
    }
    /**
     * Build API snapshot for a module
     */
    buildModuleSnapshot(ctx, filePath) {
        const { program, checker } = ctx;
        const sf = program.getSourceFile(filePath);
        if (!sf) {
            return { filePath, exports: new Map() };
        }
        const modSym = checker.getSymbolAtLocation(sf);
        const exportsMap = new Map();
        if (!modSym) {
            return { filePath, exports: new Map() };
        }
        const exportedSyms = checker.getExportsOfModule(modSym);
        for (const sym of exportedSyms) {
            const exportName = sym.getName();
            const decl = sym.declarations?.[0];
            if (!decl)
                continue;
            const span = this.getNodeSpan(decl);
            const symbolKind = this.classifySymbolKind(sym, decl, checker);
            const exportKind = exportName === "default" ? "default" : "named";
            const snap = {
                exportName,
                exportKind,
                symbolKind,
                span,
            };
            // Attach signatures for callables
            this.attachSignaturesIfCallable(snap, sym, decl, checker);
            // Attach class members
            if (symbolKind === "class") {
                this.attachClassMembers(snap, sym, decl, checker);
            }
            // Attach type members
            if (symbolKind === "type") {
                this.attachTypeMembers(snap, sym, decl, checker);
            }
            exportsMap.set(exportName, snap);
        }
        return { filePath, exports: exportsMap };
    }
    /**
     * Classify symbol kind
     */
    classifySymbolKind(sym, decl, checker) {
        if (ts.isClassDeclaration(decl) || ts.isClassExpression(decl))
            return "class";
        if (ts.isFunctionDeclaration(decl))
            return "function";
        if (ts.isInterfaceDeclaration(decl) || ts.isTypeAliasDeclaration(decl))
            return "type";
        if (ts.isEnumDeclaration(decl))
            return "enum";
        if (ts.isVariableDeclaration(decl)) {
            const init = decl.initializer;
            if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
                return "function";
            }
            return "value";
        }
        return "value";
    }
    /**
     * Attach callable signatures
     */
    attachSignaturesIfCallable(snap, sym, decl, checker) {
        const t = checker.getTypeOfSymbolAtLocation(sym, decl);
        const callSigs = t.getCallSignatures();
        if (callSigs.length === 0)
            return;
        snap.signatures = callSigs.map(sig => {
            const params = sig.getParameters().map(p => {
                const pDecl = p.valueDeclaration ?? p.declarations?.[0];
                let pType;
                if (pDecl) {
                    pType = checker.getTypeOfSymbolAtLocation(p, pDecl);
                }
                else {
                    // Fallback: try to get type from the parameter symbol directly
                    // If no declaration, we'll use a placeholder type
                    try {
                        pType = checker.getAnyType?.() || checker.getTypeAtLocation(decl);
                    }
                    catch {
                        // Ultimate fallback: use the declaration's type
                        pType = checker.getTypeAtLocation(decl);
                    }
                }
                const isOptional = pDecl ? ts.isParameter(pDecl) && !!pDecl.questionToken : false;
                const isRest = pDecl ? ts.isParameter(pDecl) && !!pDecl.dotDotDotToken : false;
                return {
                    name: p.getName(),
                    optional: isOptional,
                    rest: isRest,
                    typeText: checker.typeToString(pType, pDecl ?? decl, ts.TypeFormatFlags.NoTruncation),
                };
            });
            const ret = sig.getReturnType();
            return {
                params,
                returnTypeText: checker.typeToString(ret, decl, ts.TypeFormatFlags.NoTruncation)
            };
        });
        // Component detection heuristic
        if (snap.symbolKind === "function") {
            const looksLikeComponent = snap.signatures.some(s => /JSX\.Element|ReactElement|Element/.test(s.returnTypeText));
            if (looksLikeComponent) {
                snap.symbolKind = "component";
            }
        }
    }
    /**
     * Attach class members
     */
    attachClassMembers(snap, sym, decl, checker) {
        const classDecl = decl;
        if (!classDecl.members)
            return;
        const members = [];
        for (const m of classDecl.members) {
            const name = m.name && ts.isIdentifier(m.name) ? m.name.text : undefined;
            if (!name)
                continue;
            const flags = ts.getCombinedModifierFlags(m);
            const access = (flags & ts.ModifierFlags.Private) ? "private" :
                (flags & ts.ModifierFlags.Protected) ? "protected" : "public";
            if (access === "private")
                continue;
            if (ts.isMethodDeclaration(m) || ts.isGetAccessorDeclaration(m) || ts.isSetAccessorDeclaration(m)) {
                const msym = checker.getSymbolAtLocation(m.name);
                if (!msym)
                    continue;
                const mt = checker.getTypeOfSymbolAtLocation(msym, m);
                const callSigs = mt.getCallSignatures();
                const sigText = callSigs[0]
                    ? checker.signatureToString(callSigs[0], m, ts.TypeFormatFlags.NoTruncation)
                    : "callable";
                members.push({
                    name,
                    memberKind: "method",
                    optional: false,
                    typeText: sigText,
                    access,
                });
            }
            else if (ts.isPropertyDeclaration(m)) {
                const msym = checker.getSymbolAtLocation(m.name);
                if (!msym)
                    continue;
                const mt = checker.getTypeOfSymbolAtLocation(msym, m);
                members.push({
                    name,
                    memberKind: "property",
                    optional: !!m.questionToken,
                    typeText: checker.typeToString(mt, m, ts.TypeFormatFlags.NoTruncation),
                    access,
                });
            }
        }
        snap.classMembers = members;
    }
    /**
     * Attach type members
     */
    attachTypeMembers(snap, sym, decl, checker) {
        const t = checker.getTypeOfSymbolAtLocation(sym, decl);
        snap.typeText = checker.typeToString(t, decl, ts.TypeFormatFlags.NoTruncation);
        const props = t.getProperties();
        const members = [];
        for (const p of props) {
            const pDecl = p.valueDeclaration ?? p.declarations?.[0];
            if (!pDecl)
                continue;
            const pt = checker.getTypeOfSymbolAtLocation(p, pDecl);
            const optional = (p.getFlags() & ts.SymbolFlags.Optional) !== 0;
            members.push({
                name: p.getName(),
                memberKind: "property",
                optional,
                typeText: checker.typeToString(pt, pDecl, ts.TypeFormatFlags.NoTruncation),
                access: "public",
            });
        }
        snap.typeMembers = members;
    }
    /**
     * Get node span
     */
    getNodeSpan(node) {
        return { start: node.getStart(), end: node.getEnd() };
    }
    /**
     * Diff snapshots to find breaking changes
     */
    diffSnapshots(beforeSnap, afterSnap) {
        const changes = [];
        const beforeExports = beforeSnap.exports;
        const afterExports = afterSnap.exports;
        // TSAPI-EXP-001: removed export
        for (const [name, b] of beforeExports) {
            if (!afterExports.has(name)) {
                changes.push({
                    ruleId: "TSAPI-EXP-001",
                    changeKind: "export_removed",
                    symbolName: b.exportName === "default" ? "default" : b.exportName,
                    symbolKind: b.symbolKind,
                    filePath: beforeSnap.filePath,
                    span: b.span,
                    before: this.summarizeExport(b),
                    after: undefined,
                    impactedFiles: [],
                    impactedTests: [],
                });
            }
        }
        // TSAPI-EXP-002: default/named export changed
        const beforeHasDefault = beforeExports.has("default");
        const afterHasDefault = afterExports.has("default");
        if (beforeHasDefault !== afterHasDefault) {
            changes.push({
                ruleId: "TSAPI-EXP-002",
                changeKind: "export_kind_changed",
                symbolName: "default",
                symbolKind: "value",
                filePath: afterSnap.filePath,
                span: (afterExports.get("default") ?? beforeExports.get("default"))?.span ?? { start: 0, end: 0 },
                before: beforeHasDefault ? "default export present" : "no default export",
                after: afterHasDefault ? "default export present" : "no default export",
                impactedFiles: [],
                impactedTests: [],
            });
        }
        // Per-symbol diffs
        for (const [name, a] of afterExports) {
            const b = beforeExports.get(name);
            if (!b)
                continue; // Added exports are not breaking
            // Functions/components
            if ((a.symbolKind === "function" || a.symbolKind === "component") && b.signatures && a.signatures) {
                changes.push(...this.diffCallable(name, b, a, afterSnap.filePath));
            }
            // Classes
            if (a.symbolKind === "class" && b.classMembers && a.classMembers) {
                changes.push(...this.diffClassMembers(name, b, a, afterSnap.filePath));
            }
            // Types
            if (a.symbolKind === "type" && b.typeMembers && a.typeMembers) {
                changes.push(...this.diffTypeMembers(name, b, a, afterSnap.filePath));
            }
        }
        return changes;
    }
    /**
     * Diff callable signatures
     */
    diffCallable(exportName, before, after, filePath) {
        const out = [];
        const bSig = before.signatures?.[0];
        const aSig = after.signatures?.[0];
        if (!bSig || !aSig)
            return out;
        const bParams = bSig.params;
        const aParams = aSig.params;
        // Added required param at end
        if (aParams.length > bParams.length) {
            const added = aParams.slice(bParams.length);
            const addedRequired = added.find(p => !p.optional && !p.rest);
            if (addedRequired) {
                out.push({
                    ruleId: "TSAPI-FN-001",
                    changeKind: "signature_required_param_added",
                    symbolName: exportName,
                    symbolKind: after.symbolKind,
                    filePath,
                    span: after.span,
                    before: `${exportName}${this.formatSig(bSig)}`,
                    after: `${exportName}${this.formatSig(aSig)}`,
                    impactedFiles: [],
                    impactedTests: [],
                });
            }
        }
        // Param became required
        const len = Math.min(bParams.length, aParams.length);
        for (let i = 0; i < len; i++) {
            if (bParams[i].optional && !aParams[i].optional) {
                out.push({
                    ruleId: "TSAPI-FN-001",
                    changeKind: "signature_param_became_required",
                    symbolName: exportName,
                    symbolKind: after.symbolKind,
                    filePath,
                    span: after.span,
                    before: `${exportName}${this.formatSig(bSig)}`,
                    after: `${exportName}${this.formatSig(aSig)}`,
                    impactedFiles: [],
                    impactedTests: [],
                });
                break;
            }
        }
        // Param type narrowed (simplified - should use checker in production)
        for (let i = 0; i < len; i++) {
            if (bParams[i].typeText !== aParams[i].typeText) {
                out.push({
                    ruleId: "TSAPI-FN-002",
                    changeKind: "signature_param_type_narrowed",
                    symbolName: exportName,
                    symbolKind: after.symbolKind,
                    filePath,
                    span: after.span,
                    before: `${exportName}${this.formatSig(bSig)}`,
                    after: `${exportName}${this.formatSig(aSig)}`,
                    impactedFiles: [],
                    impactedTests: [],
                });
                break;
            }
        }
        return out;
    }
    /**
     * Diff class members
     */
    diffClassMembers(className, before, after, filePath) {
        const out = [];
        const b = new Map(before.classMembers.map(m => [m.name, m]));
        const a = new Map(after.classMembers.map(m => [m.name, m]));
        for (const [name, bm] of b) {
            const am = a.get(name);
            if (!am) {
                out.push({
                    ruleId: "TSAPI-CLS-001",
                    changeKind: "class_member_removed_or_privatised",
                    symbolName: className,
                    symbolKind: "class",
                    memberName: name,
                    memberKind: bm.memberKind,
                    filePath,
                    span: before.span,
                    before: `${className}.${name}: ${bm.typeText}`,
                    after: undefined,
                    impactedFiles: [],
                    impactedTests: [],
                });
                continue;
            }
            if (bm.memberKind !== am.memberKind) {
                out.push({
                    ruleId: "TSAPI-CLS-001",
                    changeKind: "class_member_removed_or_privatised",
                    symbolName: className,
                    symbolKind: "class",
                    memberName: name,
                    memberKind: am.memberKind,
                    filePath,
                    span: after.span,
                    before: `${className}.${name}: ${bm.memberKind}`,
                    after: `${className}.${name}: ${am.memberKind}`,
                    impactedFiles: [],
                    impactedTests: [],
                });
            }
        }
        return out;
    }
    /**
     * Diff type members
     */
    diffTypeMembers(typeName, before, after, filePath) {
        const out = [];
        const b = new Map(before.typeMembers.map(m => [m.name, m]));
        const a = new Map(after.typeMembers.map(m => [m.name, m]));
        // Required prop added or made required
        for (const [name, am] of a) {
            const bm = b.get(name);
            if (!bm && !am.optional) {
                out.push({
                    ruleId: "TSAPI-TYP-001",
                    changeKind: "type_required_prop_added_or_made_required",
                    symbolName: typeName,
                    symbolKind: "type",
                    memberName: name,
                    memberKind: "property",
                    filePath,
                    span: after.span,
                    before: `${typeName}: (missing ${name})`,
                    after: `${typeName}.${name}: ${am.typeText}`,
                    impactedFiles: [],
                    impactedTests: [],
                });
            }
            if (bm && bm.optional && !am.optional) {
                out.push({
                    ruleId: "TSAPI-TYP-001",
                    changeKind: "type_required_prop_added_or_made_required",
                    symbolName: typeName,
                    symbolKind: "type",
                    memberName: name,
                    memberKind: "property",
                    filePath,
                    span: after.span,
                    before: `${typeName}.${name}?: ${bm.typeText}`,
                    after: `${typeName}.${name}: ${am.typeText}`,
                    impactedFiles: [],
                    impactedTests: [],
                });
            }
        }
        // Prop removed or narrowed
        for (const [name, bm] of b) {
            const am = a.get(name);
            if (!am) {
                out.push({
                    ruleId: "TSAPI-TYP-002",
                    changeKind: "type_prop_removed_or_narrowed",
                    symbolName: typeName,
                    symbolKind: "type",
                    memberName: name,
                    memberKind: "property",
                    filePath,
                    span: before.span,
                    before: `${typeName}.${name}: ${bm.typeText}`,
                    after: undefined,
                    impactedFiles: [],
                    impactedTests: [],
                });
                continue;
            }
            if (bm.typeText !== am.typeText) {
                out.push({
                    ruleId: "TSAPI-TYP-002",
                    changeKind: "type_prop_removed_or_narrowed",
                    symbolName: typeName,
                    symbolKind: "type",
                    memberName: name,
                    memberKind: "property",
                    filePath,
                    span: after.span,
                    before: `${typeName}.${name}: ${bm.typeText}`,
                    after: `${typeName}.${name}: ${am.typeText}`,
                    impactedFiles: [],
                    impactedTests: [],
                });
            }
        }
        return out;
    }
    /**
     * Summarize export for display
     */
    summarizeExport(e) {
        if (e.symbolKind === "class")
            return `class ${e.exportName}`;
        if (e.symbolKind === "type")
            return `type ${e.exportName}: ${e.typeText ?? ""}`;
        if (e.signatures?.length)
            return `${e.exportName}${this.formatSig(e.signatures[0])}`;
        return `${e.symbolKind} ${e.exportName}`;
    }
    /**
     * Format signature for display
     */
    formatSig(sig) {
        const params = sig.params.map(p => `${p.name}${p.optional ? "?" : ""}: ${p.typeText}`).join(", ");
        return `(${params}) => ${sig.returnTypeText}`;
    }
    /**
     * Resolve impacts for breaking changes using TypeScript checker
     */
    async resolveImpacts(breakingChanges, ctx, projectRoot, changedFilePath) {
        const { program, checker } = ctx;
        const sourceFiles = program.getSourceFiles().filter(sf => !sf.isDeclarationFile &&
            !sf.fileName.includes('node_modules') &&
            sf.fileName !== changedFilePath);
        // Build index of all source files and test files
        const repoIndex = this.buildRepoIndex(projectRoot);
        for (const change of breakingChanges) {
            try {
                // Find the symbol in the changed file
                const changedFile = program.getSourceFile(changedFilePath);
                if (!changedFile)
                    continue;
                const symbol = this.findSymbolForChange(change, changedFile, checker);
                if (!symbol) {
                    // Fallback: use import-based resolution
                    this.resolveImpactsByImports(change, sourceFiles, repoIndex, changedFilePath);
                    continue;
                }
                // Find references to this symbol across the codebase
                const references = this.findSymbolReferences(symbol, sourceFiles, checker);
                change.impactedFiles = references.map(ref => ref.fileName);
                // Store usage locations with line numbers for navigation
                change.impactedFileLocations = references.map(ref => {
                    const sourceFile = sourceFiles.find(sf => sf.fileName === ref.fileName);
                    if (sourceFile) {
                        const pos = ref.node.getStart();
                        const { line, character } = sourceFile.getLineAndCharacterOfPosition(pos);
                        return {
                            filePath: ref.fileName,
                            line: line + 1,
                            column: character + 1
                        };
                    }
                    return {
                        filePath: ref.fileName,
                        line: 1,
                        column: 1
                    };
                });
                // Find tests that reference this symbol
                change.impactedTests = this.findTestsForSymbol(symbol, references, repoIndex, projectRoot);
            }
            catch (error) {
                console.error(`[TSBreakingChange] Error resolving impacts for ${change.symbolName}:`, error);
                // Fallback to import-based resolution
                this.resolveImpactsByImports(change, sourceFiles, repoIndex, changedFilePath);
            }
        }
    }
    /**
     * Find symbol for a breaking change
     */
    findSymbolForChange(change, sourceFile, checker) {
        try {
            // Get module symbol
            const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
            if (!moduleSymbol)
                return null;
            const exports = checker.getExportsOfModule(moduleSymbol);
            // Find the export matching the change
            for (const sym of exports) {
                const name = sym.getName();
                if (name === change.symbolName || (change.symbolName === "default" && name === "default")) {
                    // For class members, find the member symbol
                    if (change.memberName) {
                        const decl = sym.declarations?.[0];
                        if (decl && ts.isClassDeclaration(decl)) {
                            const classType = checker.getTypeOfSymbolAtLocation(sym, decl);
                            const member = classType.getProperty(change.memberName);
                            return member || null;
                        }
                    }
                    return sym;
                }
            }
        }
        catch (error) {
            console.error(`[TSBreakingChange] Error finding symbol:`, error);
        }
        return null;
    }
    /**
     * Find references to a symbol across source files
     */
    findSymbolReferences(symbol, sourceFiles, checker) {
        const references = [];
        for (const sf of sourceFiles) {
            try {
                // Check if file imports the symbol's module
                const importsSymbol = this.fileImportsSymbol(sf, symbol, checker);
                if (importsSymbol) {
                    // Find actual usage of the symbol
                    const usages = this.findSymbolUsages(sf, symbol, checker);
                    if (usages.length > 0) {
                        references.push(...usages.map(node => ({ fileName: sf.fileName, node })));
                    }
                }
            }
            catch (error) {
                // Skip files that can't be analyzed
                continue;
            }
        }
        return references;
    }
    /**
     * Check if a file imports a symbol
     */
    fileImportsSymbol(sourceFile, symbol, checker) {
        // Get the symbol's source file
        const symbolFile = symbol.valueDeclaration?.getSourceFile();
        if (!symbolFile)
            return false;
        // Check import statements
        for (const statement of sourceFile.statements) {
            if (ts.isImportDeclaration(statement)) {
                const moduleSpecifier = statement.moduleSpecifier;
                if (ts.isStringLiteral(moduleSpecifier)) {
                    const importPath = moduleSpecifier.text;
                    const symbolFilePath = symbolFile.fileName;
                    // Check if import path matches symbol's file
                    if (this.importPathMatchesFile(importPath, symbolFilePath, sourceFile.fileName)) {
                        // Check if this import includes our symbol
                        if (statement.importClause) {
                            if (statement.importClause.name && symbol.getName() === "default") {
                                return true;
                            }
                            if (statement.importClause.namedBindings) {
                                if (ts.isNamespaceImport(statement.importClause.namedBindings)) {
                                    return true; // Namespace import, could use our symbol
                                }
                                if (ts.isNamedImports(statement.importClause.namedBindings)) {
                                    for (const element of statement.importClause.namedBindings.elements) {
                                        const importedName = element.name ? element.name.text : element.propertyName?.text;
                                        if (importedName === symbol.getName()) {
                                            return true;
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        return false;
    }
    /**
     * Check if import path matches a file
     */
    importPathMatchesFile(importPath, targetFile, sourceFile) {
        // Resolve relative import paths
        const sourceDir = path.dirname(sourceFile);
        const resolvedPath = path.resolve(sourceDir, importPath);
        // Try with and without extensions
        const targetBase = targetFile.replace(/\.(ts|tsx|js|jsx)$/, '');
        const resolvedBase = resolvedPath.replace(/\.(ts|tsx|js|jsx)$/, '');
        return targetBase === resolvedBase ||
            targetFile.includes(importPath) ||
            importPath.includes(path.basename(targetFile, path.extname(targetFile)));
    }
    /**
     * Find actual usages of a symbol in a source file
     */
    findSymbolUsages(sourceFile, symbol, checker) {
        const usages = [];
        const symbolName = symbol.getName();
        function visit(node) {
            // Check identifiers
            if (ts.isIdentifier(node) && node.text === symbolName) {
                const nodeSymbol = checker.getSymbolAtLocation(node);
                if (nodeSymbol && nodeSymbol === symbol) {
                    usages.push(node);
                }
            }
            // Check property access (for class members)
            if (ts.isPropertyAccessExpression(node)) {
                if (node.name.text === symbolName) {
                    const nodeSymbol = checker.getSymbolAtLocation(node);
                    if (nodeSymbol && nodeSymbol === symbol) {
                        usages.push(node);
                    }
                }
            }
            ts.forEachChild(node, visit);
        }
        visit(sourceFile);
        return usages;
    }
    /**
     * Find tests for a symbol
     */
    findTestsForSymbol(symbol, references, repoIndex, projectRoot) {
        const testFiles = [];
        const referenceFiles = new Set(references.map(r => r.fileName));
        // Find test files that reference the symbol's file or use the symbol
        for (const testFile of repoIndex.testFiles) {
            try {
                const content = fs.readFileSync(testFile, 'utf8');
                const symbolName = symbol.getName();
                // Check if test file imports or uses the symbol
                if (content.includes(symbolName) ||
                    referenceFiles.has(testFile) ||
                    this.testFileReferencesSymbol(testFile, symbol, projectRoot)) {
                    testFiles.push(testFile);
                }
            }
            catch {
                // Skip if can't read
                continue;
            }
        }
        return testFiles;
    }
    /**
     * Check if test file references a symbol
     */
    testFileReferencesSymbol(testFile, symbol, projectRoot) {
        try {
            const content = fs.readFileSync(testFile, 'utf8');
            const symbolName = symbol.getName();
            const symbolFile = symbol.valueDeclaration?.getSourceFile()?.fileName;
            if (!symbolFile)
                return false;
            // Check if test imports the symbol's file
            const relativePath = path.relative(path.dirname(testFile), symbolFile);
            const importPath = relativePath.replace(/\\/g, '/').replace(/\.(ts|tsx)$/, '');
            return content.includes(symbolName) ||
                content.includes(importPath) ||
                content.includes(path.basename(symbolFile));
        }
        catch {
            return false;
        }
    }
    /**
     * Fallback: resolve impacts by import analysis
     */
    resolveImpactsByImports(change, sourceFiles, repoIndex, changedFilePath) {
        const impacted = [];
        const symbolName = change.symbolName;
        const changedFileBase = path.basename(changedFilePath, path.extname(changedFilePath));
        for (const sf of sourceFiles) {
            try {
                const content = fs.readFileSync(sf.fileName, 'utf8');
                // Check if file imports the changed file or uses the symbol
                if (content.includes(symbolName) ||
                    content.includes(changedFileBase) ||
                    content.includes(changedFilePath)) {
                    impacted.push(sf.fileName);
                }
            }
            catch {
                continue;
            }
        }
        change.impactedFiles = impacted;
        // Find tests
        const testFiles = [];
        for (const testFile of repoIndex.testFiles) {
            try {
                const content = fs.readFileSync(testFile, 'utf8');
                if (content.includes(symbolName) ||
                    content.includes(changedFileBase)) {
                    testFiles.push(testFile);
                }
            }
            catch {
                continue;
            }
        }
        change.impactedTests = testFiles;
    }
    /**
     * Build repository index (source files and test files)
     */
    buildRepoIndex(projectRoot) {
        const sourceFiles = [];
        const testFiles = [];
        function walk(dir) {
            try {
                const entries = fs.readdirSync(dir, { withFileTypes: true });
                for (const entry of entries) {
                    const fullPath = path.join(dir, entry.name);
                    if (entry.isDirectory()) {
                        if (!['node_modules', '.git', 'dist', 'build', 'out', '.vscode-test'].includes(entry.name)) {
                            walk(fullPath);
                        }
                    }
                    else if (entry.isFile()) {
                        const ext = path.extname(entry.name).toLowerCase();
                        if (['.ts', '.tsx', '.js', '.jsx'].includes(ext)) {
                            sourceFiles.push(fullPath);
                            // Check if it's a test file
                            if (/(\.test\.|\.spec\.|__tests__)/.test(fullPath)) {
                                testFiles.push(fullPath);
                            }
                        }
                    }
                }
            }
            catch {
                // Skip if can't read
            }
        }
        walk(projectRoot);
        return { sourceFiles, testFiles };
    }
    /**
     * Cleanup temp directories
     */
    cleanup() {
        for (const dir of this.tempDirs) {
            try {
                fs.rmSync(dir, { recursive: true, force: true });
            }
            catch (error) {
                // Ignore cleanup errors
            }
        }
        this.tempDirs = [];
    }
}
exports.TypeScriptBreakingChangeAnalyzer = TypeScriptBreakingChangeAnalyzer;
//# sourceMappingURL=TypeScriptBreakingChangeAnalyzer.js.map