import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ProfessionalImpactAnalyzer, ImpactAnalysisResult } from '../core/ProfessionalImpactAnalyzer';
import { TestRunner, TestResult } from '../test-runners/TestRunner';
import { CiBuildEntry, CiResultsPayload, CiTestRunEntry } from '../types/CiTypes';

export class ImpactViewItem extends vscode.TreeItem {
    public type: string;
    public filePath?: string;
    public analysisResult?: any;

    constructor(
        label: string,
        type: string,
        collapsibleState: vscode.TreeItemCollapsibleState
    ) {
        super(label, collapsibleState);
        this.type = type;
    }
}

interface ImpactDeltaSummary {
    newFunctions: string[];
    removedFunctions: string[];
    newClasses: string[];
    removedClasses: string[];
    newTests: string[];
    removedTests: string[];
    newDownstream: string[];
    removedDownstream: string[];
}

interface ImpactAnalysisEntry {
    result: ImpactAnalysisResult;
    analyzedAt: number;
    delta?: ImpactDeltaSummary;
}

interface CiTestLocationPayload {
    filePath?: string;
    lineNumber?: number;
    run?: CiTestRunEntry;
    build?: CiBuildEntry;
    candidates?: string[];
}

export class SimpleImpactViewProvider implements vscode.TreeDataProvider<ImpactViewItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<ImpactViewItem | undefined | null | void> = new vscode.EventEmitter<ImpactViewItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<ImpactViewItem | undefined | null | void> = this._onDidChangeTreeData.event;

    private impactAnalyzer: ProfessionalImpactAnalyzer;
    private testRunner: TestRunner;
    private analysisEntries: ImpactAnalysisEntry[] = [];
    private testResults: Map<string, TestResult> = new Map(); // Store test results by test file path
    private latestEntriesByFile: Map<string, ImpactAnalysisEntry> = new Map();
    private ciResults: CiBuildEntry[] = [];
    private ciContext: { commitHash?: string; lastUpdated?: Date } = {};

    constructor(impactAnalyzer: ProfessionalImpactAnalyzer, testRunner: TestRunner) {
        this.impactAnalyzer = impactAnalyzer;
        this.testRunner = testRunner;
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: ImpactViewItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: ImpactViewItem): Thenable<ImpactViewItem[]> {
        if (!element) {
            return this.getRootItems();
        } else if (element.type === 'recent') {
            return this.getRecentItems(element);
        } else if (element.type === 'actions') {
            return this.getActionItems();
        } else if (element.type === 'file') {
            return this.getFileItems(element);
        } else if (element.type === 'functions' || element.type === 'classes' || 
                   element.type === 'tests' || element.type === 'downstream' || 
                   element.type === 'metrics' || element.type === 'confidence' ||
                   element.type === 'confidence-metric' || element.type === 'suggestions' ||
                   element.type === 'sub-metrics' || element.type === 'sub-metric-detail' ||
                   element.type === 'breaking-issues' || element.type === 'breaking-issue' ||
                   element.type === 'breaking-category' || element.type === 'breaking-fixes' ||
                   element.type === 'ts-breaking-change' || element.type === 'ts-breaking-detail' ||
                   element.type === 'breaking-change' || element.type === 'breaking-change-evidence' ||
                   element.type === 'breaking-change-impact' || element.type === 'breaking-change-actions' ||
                   element.type === 'breaking-change-location' || element.type === 'breaking-change-impact-files' ||
                   element.type === 'breaking-change-impact-tests' || element.type === 'breaking-change-impact-usage' ||
                   element.type === 'fix' || element.type === 'run-tests' || 
                   element.type === 'run-single-test' || element.type === 'separator' ||
                   element.type === 'test-result-error' || element.type === 'test-result-stack' ||
                   element.type === 'test-result-output' || element.type === 'test-result-status' ||
                   element.type === 'test-result-error-line' || element.type === 'test-result-stack-line' ||
                   element.type === 'test-result-output-line' || element.type === 'test-result-more' ||
                   element.type === 'delta-summary' || element.type === 'delta-section' ||
                   element.type === 'delta-change' || element.type === 'ci-root' ||
                   element.type === 'ci-build' || element.type === 'ci-build-tests' ||
                   element.type === 'ci-build-tests-category' ||
                   element.type === 'ci-test' || element.type === 'ci-test-stack' ||
                   element.type === 'ci-test-metadata') {
            return this.getDetailItems(element);
        }
        return Promise.resolve([]);
    }

    private async getRootItems(): Promise<ImpactViewItem[]> {
        const items: ImpactViewItem[] = [];
        
        // Recent Analysis Results
        if (this.analysisEntries.length > 0) {
            const recentItem = new ImpactViewItem(
                'Recent Analysis',
                'recent',
                vscode.TreeItemCollapsibleState.Collapsed
            );
            recentItem.iconPath = new vscode.ThemeIcon('history');
            const latestEntry = this.analysisEntries[0];
            recentItem.description = `Last run ${this.formatRelativeTime(latestEntry.analyzedAt)}`;
            recentItem.tooltip = `Last analyzed at ${new Date(latestEntry.analyzedAt).toLocaleString()}`;
            items.push(recentItem);
        }

        // Quick Actions
        const actionsItem = new ImpactViewItem(
            'Quick Actions',
            'actions',
            vscode.TreeItemCollapsibleState.Collapsed
        );
        actionsItem.iconPath = new vscode.ThemeIcon('rocket');
        items.push(actionsItem);

        const ciRootItem = this.createCiRootItem();
        if (ciRootItem) {
            items.push(ciRootItem);
        }

        return items;
    }

    private createCiRootItem(): ImpactViewItem | undefined {
        const hasResults = this.ciResults.length > 0;
        const commit = this.ciContext.commitHash;

        if (!hasResults && !commit) {
            return undefined;
        }

        const collapsibleState = hasResults
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None;

        const ciItem = new ImpactViewItem(
            'CI Test Results',
            'ci-root',
            collapsibleState
        );
        ciItem.iconPath = new vscode.ThemeIcon('beaker');

        if (commit) {
            ciItem.description = `Commit ${commit.substring(0, 8)}`;
        } else if (!hasResults) {
            ciItem.description = 'No commit tracked';
        }

        if (this.ciContext.lastUpdated) {
            ciItem.tooltip = `Last fetched ${this.formatRelativeTime(this.ciContext.lastUpdated.getTime())}`;
        } else if (!hasResults && commit) {
            ciItem.tooltip = `Awaiting CI results for commit ${commit.substring(0, 8)}`;
        } else if (!hasResults) {
            ciItem.tooltip = 'CI results will appear after the first synced run.';
        }

        ciItem.analysisResult = { commitHash: commit };
        return ciItem;
    }

    private getCiBuildItems(): ImpactViewItem[] {
        if (this.ciResults.length === 0) {
            const placeholder = new ImpactViewItem(
                this.ciContext.commitHash ? 'No CI results received yet for this commit.' : 'CI results unavailable.',
                'ci-message',
                vscode.TreeItemCollapsibleState.None
            );
            placeholder.iconPath = new vscode.ThemeIcon('info');
            return [placeholder];
        }

        return this.ciResults.map(build => {
            const buildItem = new ImpactViewItem(
                this.formatCiBuildLabel(build),
                'ci-build',
                vscode.TreeItemCollapsibleState.Collapsed
            );
            buildItem.iconPath = new vscode.ThemeIcon(this.getCiStatusIconName(build));
            buildItem.description = this.buildCiBuildDescription(build);
            buildItem.analysisResult = { build };
            return buildItem;
        });
    }

    private formatCiBuildLabel(build: CiBuildEntry): string {
        const shortCommit = build.commitHash ? build.commitHash.substring(0, 8) : `Build ${build.buildId}`;
        if (build.summary.failed > 0) {
            return `${shortCommit} • ${build.summary.failed} failing`;
        }
        if (build.summary.total > 0) {
            return `${shortCommit} • ${build.summary.total} tests`;    
        }
        return `${shortCommit} • No tests`;
    }

    private buildCiBuildDescription(build: CiBuildEntry): string {
        const parts: string[] = [];
        if (build.summary.passed > 0) {
            parts.push(`${build.summary.passed} passed`);
        }
        if (build.summary.failed > 0) {
            parts.push(`${build.summary.failed} failed`);
        }
        if (build.summary.flaky > 0) {
            parts.push(`${build.summary.flaky} flaky`);
        }
        if (build.summary.skipped > 0) {
            parts.push(`${build.summary.skipped} skipped`);
        }
        if (build.createdAt) {
            parts.push(this.formatRelativeTime(new Date(build.createdAt).getTime()));
        }
        return parts.join(' • ');
    }

    private getCiStatusIconName(build: CiBuildEntry): string {
        if (build.summary.failed > 0) {
            return 'error';
        }
        if (build.summary.flaky > 0) {
            return 'warning';
        }
        if (build.summary.total === 0) {
            return 'watch';
        }
        return 'check';
    }

    private deriveCiStatus(build: CiBuildEntry): string {
        if (build.status) {
            return build.status;
        }
        if (build.summary.failed > 0) {
            return 'failed';
        }
        if (build.summary.total > 0 && build.summary.failed === 0) {
            return 'passed';
        }
        return 'unknown';
    }

    private createCiBuildDetailItems(build: CiBuildEntry): ImpactViewItem[] {
        const items: ImpactViewItem[] = [];

        const statusLabel = this.capitalize(this.deriveCiStatus(build));
        const commitLabel = build.commitHash ? build.commitHash.substring(0, 8) : 'Unknown commit';
        const testsLabel = `${build.summary.passed}/${build.summary.total} passed`;
        const completedLabel = build.createdAt
            ? this.formatRelativeTime(new Date(build.createdAt).getTime())
            : 'time unknown';

        const headlineParts = [
            `Status ${statusLabel}`,
            `Commit ${commitLabel}`,
            `Tests ${testsLabel}`,
            `Completed ${completedLabel}`
        ];

        const headlineItem = new ImpactViewItem(
            headlineParts.join(' • '),
            'ci-build-info',
            vscode.TreeItemCollapsibleState.None
        );
        headlineItem.iconPath = new vscode.ThemeIcon(this.getCiStatusIconName(build));
        const tooltipLines: string[] = [];
        tooltipLines.push(`Status: ${statusLabel}`);
        if (build.commitHash) {
            tooltipLines.push(`Commit: ${build.commitHash}`);
        }
        if (build.branch) {
            tooltipLines.push(`Branch: ${build.branch}`);
        }
        if (build.workflowRunId) {
            tooltipLines.push(`Workflow Run: ${build.workflowRunId}`);
        }
        tooltipLines.push(`Tests: ${build.summary.total}`);
        tooltipLines.push(`Passed: ${build.summary.passed}`);
        tooltipLines.push(`Failed: ${build.summary.failed}`);
        tooltipLines.push(`Skipped: ${build.summary.skipped}`);
        tooltipLines.push(`Flaky: ${build.summary.flaky}`);
        if (build.createdAt) {
            tooltipLines.push(`Completed at: ${new Date(build.createdAt).toLocaleString()}`);
        }
        headlineItem.tooltip = tooltipLines.join('\n');
        items.push(headlineItem);

        const failedRuns = build.testRuns.filter(run => {
            const status = (run.status || '').toLowerCase();
            return status === 'failed' || status === 'error';
        });

        const passedRuns = build.testRuns.filter(run => {
            const status = (run.status || '').toLowerCase();
            return status === 'passed';
        });

        const otherRuns = build.testRuns.filter(run => {
            const status = (run.status || '').toLowerCase();
            return status !== 'failed' && status !== 'error' && status !== 'passed';
        });

        const failedItem = new ImpactViewItem(
            `Failed Tests (${failedRuns.length})`,
            'ci-build-tests-category',
            failedRuns.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
        );
        failedItem.iconPath = new vscode.ThemeIcon('error');
        failedItem.analysisResult = { build, filter: 'failed' };
        if (failedRuns.length === 0) {
            failedItem.description = 'No failing tests';
        }
        items.push(failedItem);

        const passedItem = new ImpactViewItem(
            `Passed Tests (${passedRuns.length})`,
            'ci-build-tests-category',
            passedRuns.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
        );
        passedItem.iconPath = new vscode.ThemeIcon('check');
        passedItem.analysisResult = { build, filter: 'passed' };
        if (passedRuns.length === 0) {
            passedItem.description = 'No passing tests recorded';
        }
        items.push(passedItem);

        if (otherRuns.length > 0) {
            const otherItem = new ImpactViewItem(
                `Other Tests (${otherRuns.length})`,
                'ci-build-tests-category',
                vscode.TreeItemCollapsibleState.Collapsed
            );
            otherItem.iconPath = new vscode.ThemeIcon('circle-large-outline');
            otherItem.analysisResult = { build, filter: 'other' };
            items.push(otherItem);
        }

        return items;
    }

    private createCiTestItems(build: CiBuildEntry): ImpactViewItem[] {
        if (build.testRuns.length === 0) {
            const placeholder = new ImpactViewItem(
                'No test runs captured for this build.',
                'ci-message',
                vscode.TreeItemCollapsibleState.None
            );
            placeholder.iconPath = new vscode.ThemeIcon('info');
            return [placeholder];
        }

        return build.testRuns.map(run => this.createCiTestItem(build, run));
    }

    private createCiTestItemsForFilter(build: CiBuildEntry, filter: 'failed' | 'passed' | 'other'): ImpactViewItem[] {
        let runs: CiTestRunEntry[] = [];
        if (filter === 'failed') {
            runs = build.testRuns.filter(run => {
                const status = (run.status || '').toLowerCase();
                return status === 'failed' || status === 'error';
            });
        } else if (filter === 'passed') {
            runs = build.testRuns.filter(run => (run.status || '').toLowerCase() === 'passed');
        } else {
            runs = build.testRuns.filter(run => {
                const status = (run.status || '').toLowerCase();
                return status !== 'failed' && status !== 'error' && status !== 'passed';
            });
        }

        if (runs.length === 0) {
            const label = filter === 'failed'
                ? 'No failing tests for this commit.'
                : filter === 'passed'
                ? 'No passing tests recorded for this commit.'
                : 'No additional tests recorded.';
            const placeholder = new ImpactViewItem(
                label,
                'ci-message',
                vscode.TreeItemCollapsibleState.None
            );
            placeholder.iconPath = new vscode.ThemeIcon(filter === 'failed' ? 'info' : filter === 'passed' ? 'check' : 'circle-large-outline');
            return [placeholder];
        }

        const filteredRuns = runs.map(run => this.createCiTestItem(build, run));

        const extraStatuses = new Set<string>();
        for (const run of runs) {
            const status = (run.status || '').toLowerCase();
            if (filter === 'failed' && status !== 'failed' && status !== 'error') {
                extraStatuses.add(status);
            }
            if (filter === 'passed' && status !== 'passed') {
                extraStatuses.add(status);
            }
            if (filter === 'other' && (status === 'failed' || status === 'error' || status === 'passed')) {
                extraStatuses.add(status);
            }
        }

        if (extraStatuses.size > 0) {
            const note = new ImpactViewItem(
                `Includes statuses: ${Array.from(extraStatuses).join(', ')}`,
                'ci-message',
                vscode.TreeItemCollapsibleState.None
            );
            note.iconPath = new vscode.ThemeIcon('info');
            filteredRuns.push(note);
        }

        return filteredRuns;
    }

    private createCiTestItem(build: CiBuildEntry, run: CiTestRunEntry): ImpactViewItem {
        const hasDetails = Boolean(run.errorMessage) || Boolean(run.stackTrace) || (run.metadata && Object.keys(run.metadata).length > 0);
        const collapsibleState = hasDetails ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None;
        const testItem = new ImpactViewItem(
            this.formatCiTestLabel(run),
            'ci-test',
            collapsibleState
        );
        testItem.iconPath = new vscode.ThemeIcon(this.getCiTestIconName(run));
        testItem.analysisResult = { run, build };

        const descriptionParts: string[] = [];
        if (run.testSuite) {
            descriptionParts.push(this.getDisplayPath(run.testSuite));
        }
        const duration = this.formatDuration(run.duration);
        if (duration) {
            descriptionParts.push(duration);
        }

        const location = this.extractLocationFromRun(run);
        if (location?.lineNumber) {
            descriptionParts.push(`line ${location.lineNumber}`);
        }

        if (descriptionParts.length > 0) {
            testItem.description = descriptionParts.join(' • ');
        }

        const commandPayload = this.buildCiTestLocationPayload(build, run, location);
        testItem.command = {
            command: 'impactAnalyzer.openCiTestLocation',
            title: 'Open Test Location',
            arguments: [commandPayload]
        };

        return testItem;
    }

    private buildCiTestLocationPayload(build: CiBuildEntry, run: CiTestRunEntry, location?: { filePath: string; lineNumber?: number }): CiTestLocationPayload {
        return {
            build,
            run,
            filePath: location?.filePath,
            lineNumber: location?.lineNumber,
            candidates: this.buildPathCandidates(run, location)
        };
    }

    private buildPathCandidates(run: CiTestRunEntry, location?: { filePath: string; lineNumber?: number }): string[] {
        const candidates = new Set<string>();
        const addCandidate = (value?: unknown) => {
            if (typeof value === 'string') {
                const trimmed = value.trim();
                if (trimmed.length > 0) {
                    candidates.add(trimmed);
                }
            }
        };

        addCandidate(location?.filePath);

        const metadata = run.metadata ?? {};
        const metadataKeys = [
            'filePath',
            'filepath',
            'path',
            'relativePath',
            'repoPath',
            'repoFilePath',
            'sourcePath',
            'absolutePath',
            'file',
            'fullPath',
            'relativeFilePath',
            'workspacePath'
        ];
        for (const key of metadataKeys) {
            addCandidate(metadata[key]);
        }

        if (typeof metadata.fileName === 'string') {
            addCandidate(metadata.fileName);
            if (typeof metadata.directory === 'string') {
                addCandidate(path.join(metadata.directory, metadata.fileName));
            }
            if (typeof metadata.package === 'string') {
                addCandidate(path.join(metadata.package.replace(/\./g, '/'), metadata.fileName));
            }
        }

        if (metadata.packageName && metadata.className) {
            const extension = this.ensureExtension(metadata.extension || metadata.fileExtension || metadata.fileExt);
            addCandidate(path.join(String(metadata.packageName).replace(/\./g, '/'), `${metadata.className}${extension}`));
        }

        addCandidate(run.testSuite);
        if (run.testSuite && !run.testSuite.includes('/') && !run.testSuite.includes('\\')) {
            const suitePath = run.testSuite.replace(/\./g, '/');
            const guessedExtension = this.guessExtensionFromRun(run, metadata);
            if (guessedExtension) {
                addCandidate(`${suitePath}${guessedExtension.startsWith('.') ? guessedExtension : `.${guessedExtension}`}`);
            } else {
                addCandidate(suitePath);
            }
        }

        if (typeof metadata.className === 'string' && typeof metadata.package === 'string') {
            const extension = this.ensureExtension(metadata.extension || metadata.fileExtension || metadata.fileExt);
            addCandidate(path.join(metadata.package.replace(/\./g, '/'), `${metadata.className}${extension}`));
        }

        return Array.from(candidates);
    }

    private ensureExtension(value: unknown, defaultExt: string = '.java'): string {
        if (typeof value !== 'string' || value.trim().length === 0) {
            return defaultExt;
        }
        const trimmed = value.trim();
        return trimmed.startsWith('.') ? trimmed : `.${trimmed}`;
    }

    private guessExtensionFromRun(run: CiTestRunEntry, metadata: Record<string, any>): string | undefined {
        const metaExt = metadata?.extension || metadata?.fileExtension || metadata?.fileExt;
        if (typeof metaExt === 'string' && metaExt.trim().length > 0) {
            return metaExt.startsWith('.') ? metaExt : `.${metaExt}`;
        }

        if (typeof metadata?.fileName === 'string') {
            const ext = path.extname(metadata.fileName);
            if (ext) {
                return ext;
            }
        }

        const framework = (run.framework || '').toLowerCase();
        if (framework.includes('junit') || framework.includes('testng')) {
            return '.java';
        }
        if (framework.includes('pytest') || framework.includes('nose')) {
            return '.py';
        }
        if (framework.includes('jest') || framework.includes('mocha') || framework.includes('cypress') || framework.includes('playwright')) {
            return '.ts';
        }
        if (framework.includes('rspec')) {
            return '.rb';
        }
        if (framework.includes('go')) {
            return '.go';
        }

        return undefined;
    }

    async openCiTestLocation(payload?: CiTestLocationPayload): Promise<void> {
        if (!payload) {
            vscode.window.showWarningMessage('Impact Analyzer: Unable to open test location (missing payload).');
            return;
        }

        const locationFromRun = payload.run ? this.extractLocationFromRun(payload.run) : undefined;
        const lineNumber = payload.lineNumber ?? locationFromRun?.lineNumber;

        const candidateSet = new Set<string>();
        if (payload.filePath) {
            candidateSet.add(payload.filePath);
        }
        if (payload.candidates) {
            for (const candidate of payload.candidates) {
                if (candidate) {
                    candidateSet.add(candidate);
                }
            }
        }
        if (payload.run) {
            for (const candidate of this.buildPathCandidates(payload.run, locationFromRun)) {
                candidateSet.add(candidate);
            }
        }

        const candidates = Array.from(candidateSet);
        const uri = await this.resolveCandidateUri(candidates);

        if (!uri) {
            const label = payload.run?.testSuite || payload.filePath || 'test run';
            vscode.window.showWarningMessage(`Impact Analyzer: Unable to locate source file for ${label}.`);
            return;
        }

        const lineIndex = lineNumber ? Math.max(lineNumber - 1, 0) : 0;
        await vscode.window.showTextDocument(uri, {
            selection: new vscode.Range(lineIndex, 0, lineIndex, 0)
        });
    }

    private async resolveCandidateUri(candidates: string[]): Promise<vscode.Uri | undefined> {
        if (candidates.length === 0) {
            return undefined;
        }

        const attempted = new Set<string>();
        const workspaceFolders = vscode.workspace.workspaceFolders;

        for (const candidate of candidates) {
            const variants = this.expandCandidateVariants(candidate);
            for (const variant of variants) {
                if (attempted.has(variant)) {
                    continue;
                }
                attempted.add(variant);

                if (fs.existsSync(variant)) {
                    return vscode.Uri.file(variant);
                }

                if (workspaceFolders) {
                    for (const folder of workspaceFolders) {
                        const fullPath = path.resolve(folder.uri.fsPath, variant);
                        if (fs.existsSync(fullPath)) {
                            return vscode.Uri.file(fullPath);
                        }
                    }
                }
            }
        }

        if (!workspaceFolders || workspaceFolders.length === 0) {
            return undefined;
        }

        const normalizedCandidates = candidates
            .map(candidate => this.normalizeCandidate(candidate))
            .filter((value): value is string => typeof value === 'string' && value.length > 0);

        const basenames = Array.from(new Set(
            normalizedCandidates.map(candidate => path.basename(candidate)).filter(name => !!name && name !== '.' && name !== '/')
        ));

        for (const basename of basenames) {
            const files = await vscode.workspace.findFiles(`**/${basename}`, '**/{.git,node_modules,bower_components,dist,out}/**', 25);
            if (files.length === 0) {
                continue;
            }
            if (files.length === 1) {
                return files[0];
            }

            const loweredCandidates = normalizedCandidates.map(candidate => candidate.toLowerCase());
            for (const file of files) {
                const filePathLower = file.fsPath.replace(/\\/g, '/').toLowerCase();
                if (loweredCandidates.some(candidate => filePathLower.endsWith(candidate))) {
                    return file;
                }
            }

            return files[0];
        }

        return undefined;
    }

    private normalizeCandidate(value: string): string | undefined {
        if (typeof value !== 'string') {
            return undefined;
        }

        let normalized = value.trim();
        if (normalized.length === 0) {
            return undefined;
        }

        normalized = normalized.replace(/^file:\/+/, '');
        normalized = normalized.replace(/^\\\\\?\\/, '');
        normalized = normalized.replace(/\\/g, '/');

        if (normalized.startsWith('~')) {
            const home = process.env.HOME || process.env.USERPROFILE;
            if (home) {
                normalized = path.join(home, normalized.slice(1));
            }
        }

        return normalized;
    }

    private expandCandidateVariants(candidate: string): string[] {
        const variants = new Set<string>();
        const normalized = this.normalizeCandidate(candidate);
        if (!normalized) {
            return [];
        }

        variants.add(normalized);
        variants.add(normalized.replace(/\//g, path.sep));

        const withoutDrive = normalized.replace(/^[A-Za-z]:/, '').replace(/^\/+/, '');
        if (withoutDrive.length > 0) {
            variants.add(withoutDrive);
            variants.add(withoutDrive.replace(/\//g, path.sep));
        }

        return Array.from(variants).filter(value => value.length > 0);
    }

    private formatCiTestLabel(run: CiTestRunEntry): string {
        const status = run.status.toLowerCase();
        const suite = run.testSuite ? this.getDisplayPath(run.testSuite) : 'Test';
        const name = run.name ? `: ${run.name}` : '';

        let prefix = 'ℹ️';
        if (status === 'passed') {
            prefix = '✅';
        } else if (status === 'failed' || status === 'error') {
            prefix = '❌';
        } else if (status === 'skipped') {
            prefix = '⏭️';
        } else if (status === 'flaky') {
            prefix = '⚠️';
        }

        return `${prefix} ${suite}${name}`;
    }

    private getCiTestIconName(run: CiTestRunEntry): string {
        const status = run.status.toLowerCase();
        if (status === 'passed') {
            return 'check';
        }
        if (status === 'failed' || status === 'error') {
            return 'error';
        }
        if (status === 'skipped') {
            return 'circle-slash';
        }
        if (status === 'flaky') {
            return 'warning';
        }
        return 'question';
    }

    private createCiTestDetailItems(run: CiTestRunEntry): ImpactViewItem[] {
        const items: ImpactViewItem[] = [];

        if (run.errorMessage) {
            const errorItem = new ImpactViewItem(
                run.errorMessage,
                'ci-test-message',
                vscode.TreeItemCollapsibleState.None
            );
            errorItem.iconPath = new vscode.ThemeIcon('error');
            items.push(errorItem);
        }

        if (run.stackTrace) {
            const stackItem = new ImpactViewItem(
                'Stack Trace',
                'ci-test-stack',
                vscode.TreeItemCollapsibleState.Collapsed
            );
            stackItem.iconPath = new vscode.ThemeIcon('list-selection');
            stackItem.analysisResult = { stackTrace: run.stackTrace };
            items.push(stackItem);
        }

        if (run.metadata && Object.keys(run.metadata).length > 0) {
            const metadataItem = new ImpactViewItem(
                'Metadata',
                'ci-test-metadata',
                vscode.TreeItemCollapsibleState.Collapsed
            );
            metadataItem.iconPath = new vscode.ThemeIcon('bracket-dot');
            metadataItem.analysisResult = { metadata: run.metadata };
            items.push(metadataItem);
        }

        return items;
    }

    private createCiStackItems(stackTrace: string): ImpactViewItem[] {
        const lines = stackTrace.split(/\r?\n/).filter(line => line.trim().length > 0);
        if (lines.length === 0) {
            const placeholder = new ImpactViewItem('No stack trace entries', 'ci-message', vscode.TreeItemCollapsibleState.None);
            placeholder.iconPath = new vscode.ThemeIcon('info');
            return [placeholder];
        }

        return lines.slice(0, 50).map(line => {
            const lineItem = new ImpactViewItem(line.trim(), 'ci-test-stack-line', vscode.TreeItemCollapsibleState.None);
            lineItem.iconPath = new vscode.ThemeIcon('chevron-right');
            return lineItem;
        });
    }

    private createCiMetadataItems(metadata: Record<string, any>): ImpactViewItem[] {
        const entries = Object.entries(metadata);
        if (entries.length === 0) {
            const placeholder = new ImpactViewItem('No metadata available', 'ci-message', vscode.TreeItemCollapsibleState.None);
            placeholder.iconPath = new vscode.ThemeIcon('info');
            return [placeholder];
        }

        return entries.map(([key, value]) => {
            const displayValue = typeof value === 'string'
                ? value
                : JSON.stringify(value, null, 2);

            const trimmedValue = displayValue.length > 200 ? `${displayValue.substring(0, 200)}…` : displayValue;

            const metadataItem = new ImpactViewItem(
                `${key}: ${trimmedValue}`,
                'ci-test-metadata-entry',
                vscode.TreeItemCollapsibleState.None
            );
            metadataItem.iconPath = new vscode.ThemeIcon('symbol-field');
            return metadataItem;
        });
    }

    private formatDuration(duration?: number | null): string | undefined {
        if (duration === undefined || duration === null || isNaN(duration)) {
            return undefined;
        }

        if (duration > 1000) {
            return `${Math.round(duration / 1000)}s`;
        }

        if (duration > 1) {
            return `${duration.toFixed(1)}s`;
        }

        if (duration > 0) {
            return `${Math.max(Math.round(duration * 1000), 1)}ms`;
        }

        return undefined;
    }

    private extractLocationFromRun(run: CiTestRunEntry): { filePath: string; lineNumber?: number } | undefined {
        const metadata = run.metadata || {};
        const metadataPath = metadata.filePath || metadata.filepath || metadata.path;
        const metadataLineRaw = metadata.lineNumber ?? metadata.line ?? metadata.line_number;
        let lineNumber: number | undefined;
        if (typeof metadataLineRaw === 'number') {
            lineNumber = metadataLineRaw;
        } else if (typeof metadataLineRaw === 'string') {
            const parsed = parseInt(metadataLineRaw, 10);
            if (!isNaN(parsed)) {
                lineNumber = parsed;
            }
        }

        if (typeof metadataPath === 'string') {
            return { filePath: metadataPath, lineNumber };
        }

        if (run.stackTrace) {
            const lines = run.stackTrace.split(/\r?\n/);
            const regex = /((?:[a-zA-Z]:)?[^:\s]+?\.(?:ts|tsx|js|jsx|py|java|cs)):(\d+)(?::(\d+))?/;
            for (const line of lines) {
                const match = line.match(regex);
                if (match) {
                    const filePath = match[1];
                    const lineNumber = parseInt(match[2], 10);
                    return { filePath, lineNumber: isNaN(lineNumber) ? undefined : lineNumber };
                }
            }
        }

        return undefined;
    }

    private resolveFilePath(filePathValue: string): string | undefined {
        const variants = this.expandCandidateVariants(filePathValue);
        const workspaceFolders = vscode.workspace.workspaceFolders;

        for (const variant of variants) {
            if (fs.existsSync(variant)) {
                return variant;
            }
            if (workspaceFolders) {
                for (const folder of workspaceFolders) {
                    const resolved = path.resolve(folder.uri.fsPath, variant);
                    if (fs.existsSync(resolved)) {
                        return resolved;
                    }
                }
            }
        }

        return undefined;
    }

    private getDisplayPath(rawPath: string): string {
        const workspace = vscode.workspace.workspaceFolders?.[0];
        if (!workspace) {
            return path.basename(rawPath);
        }
        const relative = path.relative(workspace.uri.fsPath, rawPath);
        return relative || path.basename(rawPath);
    }

    private capitalize(value: string): string {
        if (!value) {
            return value;
        }
        return value.charAt(0).toUpperCase() + value.slice(1);
    }

    private async getFileItems(fileElement: ImpactViewItem): Promise<ImpactViewItem[]> {
        const items: ImpactViewItem[] = [];
        const analysisPayload = fileElement.analysisResult;
        const result: ImpactAnalysisResult | undefined = analysisPayload?.result ?? analysisPayload;
        const entry: ImpactAnalysisEntry | undefined = analysisPayload?.entry;
        
        if (!result) {
            return items;
        }

        if (entry) {
            const timestampItem = new ImpactViewItem(
                `Analyzed ${this.formatRelativeTime(entry.analyzedAt)}`,
                'analysis-timestamp',
                vscode.TreeItemCollapsibleState.None
            );
            timestampItem.iconPath = new vscode.ThemeIcon('clock');
            timestampItem.description = new Date(entry.analyzedAt).toLocaleString();
            items.push(timestampItem);
        }

        if (entry?.delta && this.deltaHasChanges(entry.delta)) {
            const deltaItem = new ImpactViewItem(
                'Change Highlights',
                'delta-summary',
                vscode.TreeItemCollapsibleState.Collapsed
            );
            deltaItem.iconPath = new vscode.ThemeIcon('diff');
            deltaItem.analysisResult = { delta: entry.delta, result };
            deltaItem.description = this.buildDeltaSummary(entry.delta);
            items.push(deltaItem);
        }

        // Check if no changes were detected
        if (result.hasActualChanges === false) {
            const noChangesItem = new ImpactViewItem(
                'ℹ️ No code change detected',
                'no-changes',
                vscode.TreeItemCollapsibleState.None
            );
            noChangesItem.iconPath = new vscode.ThemeIcon('info');
            noChangesItem.description = 'No changes to analyze';
            noChangesItem.tooltip = 'This file has no uncommitted changes. Make changes to the file and try again.';
            items.push(noChangesItem);
            return items;
        }

        // WHAT WILL BREAK - Show TypeScript breaking changes first (EXPANDED by default)
        // IMPORTANT: Only count breakingChanges, never count impacts as separate issues
        const tsBreakingChanges = Array.isArray(result.breakingChanges) ? result.breakingChanges : [];
        // Only extract legacy breaking issues if we don't have TypeScript breaking changes
        const legacyBreakingIssues = tsBreakingChanges.length === 0 ? this.extractBreakingIssues(result) : [];
        
        // DEBUG: Log what we're working with
        console.log(`[UI] Breaking changes count: ${tsBreakingChanges.length}, Legacy issues: ${legacyBreakingIssues.length}`);
        
        if (tsBreakingChanges.length > 0) {
            // Calculate risk level from breaking changes
            const riskLevel = this.calculateRiskFromBreakingChanges(tsBreakingChanges);
            const riskLabel = riskLevel === 'high' ? 'High risk' : riskLevel === 'medium' ? 'Medium risk' : 'Low risk';
            
            // Count impacts across all breaking changes (for summary, not for issue count)
            const totalImpactedFiles = new Set<string>();
            const totalImpactedTests = new Set<string>();
            const totalAffectedFunctions = new Set<string>();
            
            for (const change of tsBreakingChanges) {
                (change.impactedFiles || []).forEach((f: string) => totalImpactedFiles.add(f));
                (change.impactedTests || []).forEach((t: string) => totalImpactedTests.add(t));
                if (change.symbolKind === 'function' || change.symbolKind === 'method') {
                    totalAffectedFunctions.add(change.symbolName);
                }
            }
            
            // Build impact summary for display (not for counting)
            const impactParts: string[] = [];
            if (totalAffectedFunctions.size > 0) {
                impactParts.push(`${totalAffectedFunctions.size} function${totalAffectedFunctions.size !== 1 ? 's' : ''}`);
            }
            if (totalImpactedTests.size > 0) {
                impactParts.push(`${totalImpactedTests.size} test${totalImpactedTests.size !== 1 ? 's' : ''}`);
            }
            if (totalImpactedFiles.size > 0) {
                impactParts.push(`${totalImpactedFiles.size} downstream`);
            }
            
            // Use appropriate icon and label based on severity
            const isCritical = riskLevel === 'high';
            const breakingItem = new ImpactViewItem(
                `${isCritical ? '🚨' : '⚠️'} What Will Break (${tsBreakingChanges.length})`,
                'breaking-issues',
                vscode.TreeItemCollapsibleState.Expanded // Expanded by default to show immediately
            );
            
            // Color code based on risk level - use warning (yellow) for medium, error (red) only for high
            const riskColor = riskLevel === 'high' 
                ? new vscode.ThemeColor('errorForeground')
                : riskLevel === 'medium'
                ? new vscode.ThemeColor('warningForeground')
                : new vscode.ThemeColor('textLinkForeground');
            
            // Use error icon for critical, warning icon for medium/low
            const iconName = isCritical ? 'error' : 'warning';
            breakingItem.iconPath = new vscode.ThemeIcon(iconName, riskColor);
            breakingItem.analysisResult = { breakingChanges: tsBreakingChanges, result, riskLevel };
            
            // Format: "1 breaking change (Medium risk)" - impacts shown separately in tooltip
            const severityText = riskLevel === 'high' ? 'Critical' : riskLevel === 'medium' ? 'Medium' : 'Low';
            breakingItem.description = `${tsBreakingChanges.length} breaking change${tsBreakingChanges.length !== 1 ? 's' : ''} (${severityText} risk)`;
            breakingItem.tooltip = this.buildBreakingChangesTooltip(tsBreakingChanges, result, riskLevel, totalImpactedFiles.size, totalImpactedTests.size, totalAffectedFunctions.size);
            items.push(breakingItem);
        } else if (legacyBreakingIssues.length > 0) {
            // Fallback to legacy breaking issues if no TypeScript breaking changes
            // Legacy issues are treated as critical by default
            const breakingItem = new ImpactViewItem(
                `🚨 What Will Break (${legacyBreakingIssues.length})`,
                'breaking-issues',
                vscode.TreeItemCollapsibleState.Expanded
            );
            breakingItem.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'));
            breakingItem.analysisResult = { breakingIssues: legacyBreakingIssues, result };
            breakingItem.description = `${legacyBreakingIssues.length} breaking change${legacyBreakingIssues.length !== 1 ? 's' : ''} (Critical risk)`;
            items.push(breakingItem);
        } else {
            // Show success message if no issues
            const noIssuesItem = new ImpactViewItem(
                '✅ No Breaking Issues Detected',
                'breaking-issues',
                vscode.TreeItemCollapsibleState.None
            );
            noIssuesItem.iconPath = new vscode.ThemeIcon('check', new vscode.ThemeColor('testing.iconPassed'));
            noIssuesItem.analysisResult = { breakingIssues: [], result };
            items.push(noIssuesItem);
        }

        // Changed Classes
        if (result.changedClasses && result.changedClasses.length > 0) {
            const classesItem = new ImpactViewItem(
                `Classes (${result.changedClasses.length})`,
                'classes',
                vscode.TreeItemCollapsibleState.Collapsed
            );
            classesItem.analysisResult = result;
            classesItem.iconPath = new vscode.ThemeIcon('symbol-class');
            items.push(classesItem);
        }

        // Downstream Components - HIDDEN (shown in "What Will Break" instead)
        // if (result.downstreamComponents && result.downstreamComponents.length > 0) {
        //     const downstreamItem = new ImpactViewItem(
        //         `Downstream Components (${result.downstreamComponents.length})`,
        //         'downstream',
        //         vscode.TreeItemCollapsibleState.Collapsed
        //     );
        //     downstreamItem.analysisResult = result;
        //     downstreamItem.iconPath = new vscode.ThemeIcon('arrow-down');
        //     items.push(downstreamItem);
        // }

        // Confidence Metrics - HIDDEN
        // if (result.confidenceResult) {
        //     const confidenceItem = new ImpactViewItem(
        //         `Confidence Score: ${result.confidenceResult.statusIcon} ${result.confidenceResult.total}/100 (${result.confidenceResult.status})`,
        //         'confidence',
        //         vscode.TreeItemCollapsibleState.Collapsed
        //     );
        //     confidenceItem.analysisResult = result;
        //     confidenceItem.iconPath = new vscode.ThemeIcon('graph');
        //     confidenceItem.description = result.confidenceResult.changedLines 
        //         ? `${result.confidenceResult.changedLines} lines changed` 
        //         : '';
        //     items.push(confidenceItem);
        // }

        // Legacy Metrics - HIDDEN
        // const metricsItem = new ImpactViewItem(
        //     'Legacy Metrics',
        //     'metrics',
        //     vscode.TreeItemCollapsibleState.Collapsed
        // );
        // metricsItem.analysisResult = result;
        // metricsItem.iconPath = new vscode.ThemeIcon('graph');
        // items.push(metricsItem);

        return items;
    }

    private async getRecentItems(recentElement: ImpactViewItem): Promise<ImpactViewItem[]> {
        const items: ImpactViewItem[] = [];
        
        for (const entry of this.analysisEntries) {
            const result = entry.result;
            const fileName = require('path').basename(result.filePath);
            const fileItem = new ImpactViewItem(
                fileName,
                'file',
                vscode.TreeItemCollapsibleState.Collapsed
            );
            fileItem.filePath = result.filePath;
            fileItem.analysisResult = { result, entry };

            // Count breaking changes - check both TypeScript and legacy
            const tsBreakingChanges = result.breakingChanges || [];
            const legacyBreakingIssues = tsBreakingChanges.length === 0 ? this.extractBreakingIssues(result) : [];
            const hasBreakingChanges = tsBreakingChanges.length > 0 || legacyBreakingIssues.length > 0;
            
            // Calculate risk level and severity
            let riskLevel: 'low' | 'medium' | 'high' = 'low';
            let severityLabel = '';
            if (hasBreakingChanges) {
                if (tsBreakingChanges.length > 0) {
                    riskLevel = this.calculateRiskFromBreakingChanges(tsBreakingChanges);
                } else {
                    // Legacy breaking issues are treated as medium risk by default
                    riskLevel = 'medium';
                }
                severityLabel = riskLevel === 'high' ? 'Critical' : riskLevel === 'medium' ? 'Medium' : 'Low';
            }
            
            // Use appropriate icon and color based on risk level
            if (hasBreakingChanges) {
                const riskColor = riskLevel === 'high' 
                    ? new vscode.ThemeColor('errorForeground')
                    : riskLevel === 'medium'
                    ? new vscode.ThemeColor('warningForeground')
                    : new vscode.ThemeColor('textLinkForeground');
                // Use error icon for critical, warning icon for medium/low
                const iconName = riskLevel === 'high' ? 'error' : 'warning';
                fileItem.iconPath = new vscode.ThemeIcon(iconName, riskColor);
            } else {
                fileItem.iconPath = new vscode.ThemeIcon('check', new vscode.ThemeColor('testing.iconPassed'));
            }

            const summaryParts: string[] = [];
            if (hasBreakingChanges) {
                const totalBreakingChanges = tsBreakingChanges.length > 0 ? tsBreakingChanges.length : legacyBreakingIssues.length;
                summaryParts.push(`${totalBreakingChanges} breaking change${totalBreakingChanges !== 1 ? 's' : ''}`);
                if (severityLabel) {
                    summaryParts.push(`(${severityLabel} risk)`);
                }
            } else {
                summaryParts.push('No breaking changes');
            }

            // Don't show change summary if we have breaking changes (it's redundant)
            // Only show it if there are no breaking changes but there are other changes
            if (!hasBreakingChanges) {
                const changeSummary = this.buildChangeSummary(result);
                if (changeSummary) {
                    summaryParts.push(changeSummary);
                }
            } else {
                // For breaking changes, show impact summary instead
                const tsBreakingChanges = result.breakingChanges || [];
                if (tsBreakingChanges.length > 0) {
                    const totalImpactedFiles = new Set<string>();
                    const totalImpactedTests = new Set<string>();
                    const totalAffectedFunctions = new Set<string>();
                    
                    for (const change of tsBreakingChanges) {
                        (change.impactedFiles || []).forEach((f: string) => totalImpactedFiles.add(f));
                        (change.impactedTests || []).forEach((t: string) => totalImpactedTests.add(t));
                        if (change.symbolKind === 'function' || change.symbolKind === 'method') {
                            totalAffectedFunctions.add(change.symbolName);
                        }
                    }
                    
                    const impactParts: string[] = [];
                    if (totalAffectedFunctions.size > 0) {
                        impactParts.push(`${totalAffectedFunctions.size} function${totalAffectedFunctions.size !== 1 ? 's' : ''}`);
                    }
                    if (totalImpactedTests.size > 0) {
                        impactParts.push(`${totalImpactedTests.size} test${totalImpactedTests.size !== 1 ? 's' : ''}`);
                    }
                    if (totalImpactedFiles.size > 0) {
                        impactParts.push(`${totalImpactedFiles.size} downstream`);
                    }
                    
                    if (impactParts.length > 0) {
                        summaryParts.push(`Affects ${impactParts.join(', ')}`);
                    }
                }
            }

            if (entry.delta && this.deltaHasChanges(entry.delta)) {
                summaryParts.push(`Δ ${this.buildDeltaSummary(entry.delta)}`);
            }

            summaryParts.push(`analyzed ${this.formatRelativeTime(entry.analyzedAt)}`);
            fileItem.description = summaryParts.join(' • ');
            fileItem.tooltip = this.buildFileTooltip(result, entry);
            items.push(fileItem);
        }
        
        return items;
    }

    private async getActionItems(): Promise<ImpactViewItem[]> {
        const items: ImpactViewItem[] = [];
        
        const analyzeItem = new ImpactViewItem(
            'Analyze Current File',
            'action',
            vscode.TreeItemCollapsibleState.None
        );
        analyzeItem.iconPath = new vscode.ThemeIcon('search');
        analyzeItem.command = {
            command: 'impactAnalyzer.analyzeCurrentFile',
            title: 'Analyze Current File'
        };
        items.push(analyzeItem);

        const workspaceItem = new ImpactViewItem(
            'Analyze Workspace',
            'action',
            vscode.TreeItemCollapsibleState.None
        );
        workspaceItem.iconPath = new vscode.ThemeIcon('folder');
        workspaceItem.command = {
            command: 'impactAnalyzer.analyzeWorkspace',
            title: 'Analyze Workspace'
        };
        items.push(workspaceItem);

        return items;
    }

    /**
     * Extract breaking issues from analysis result
     * Focuses on impact analysis: what code depends on changes and could break
     */
    private extractBreakingIssues(result: any): Array<{ severity: string; message: string; line: number; category: string; file?: string; recommendedFixes?: string[] }> {
        const breakingIssues: Array<{ severity: string; message: string; line: number; category: string; file?: string; recommendedFixes?: string[] }> = [];
        
        // Get fix recommendations from Contracts & Architecture metric
        let contractsMetric: any = null;
        if (result.confidenceResult) {
            const confidence = result.confidenceResult;
            for (const metric of confidence.metrics || []) {
                if (metric.name === 'Contracts & Architecture') {
                    contractsMetric = metric;
                    // Contracts & Architecture - Breaking changes
                    if (metric.subMetrics?.breakingChanges) {
                        for (const breakingChange of metric.subMetrics.breakingChanges) {
                            breakingIssues.push({
                                severity: '⚠️ Breaking',
                                message: breakingChange || 'Breaking API change',
                                line: 0,
                                category: 'API Breaking Change',
                                file: result.filePath,
                                recommendedFixes: metric.suggestions || [
                                    'Maintain backward-compatible function signatures',
                                    'Add deprecated annotation with migration path',
                                    'Update all call sites before removing old API',
                                    'Document breaking changes in CHANGELOG',
                                    'Consider version bump if breaking change is necessary'
                                ]
                            });
                        }
                    }
                    break;
                }
            }
        }
        
        // Impact Analysis - Code that depends on changes and could break
        
        const uniqueDownstream: string[] = Array.isArray(result.downstreamComponents)
            ? Array.from(
                new Set(
                    result.downstreamComponents
                        .filter((value: unknown): value is string => typeof value === 'string')
                )
            )
            : [];

        const uniqueAffectedTests: string[] = Array.isArray(result.affectedTests)
            ? Array.from(
                new Set(
                    result.affectedTests
                        .filter((value: unknown): value is string => typeof value === 'string')
                )
            )
            : [];

        const uniqueChangedFunctions: string[] = Array.isArray(result.changedFunctions)
            ? Array.from(
                new Set(
                    result.changedFunctions
                        .filter((value: unknown): value is string => typeof value === 'string')
                )
            )
            : [];

        const uniqueChangedClasses: string[] = Array.isArray(result.changedClasses)
            ? Array.from(
                new Set(
                    result.changedClasses
                        .filter((value: unknown): value is string => typeof value === 'string')
                )
            )
            : [];

        // IMPORTANT: Only count actual breaking changes (changed functions/classes), NOT impacts
        // Impacts (downstream, tests) are shown as context, not as separate breaking issues
        
        // Changed functions/classes that other code depends on - these are the actual breaking changes
        if (uniqueChangedFunctions.length > 0) {
            // Only count if there are downstream components (indicating other code depends on it)
            // Count as 1 breaking change per changed function, not per impact
            for (const func of uniqueChangedFunctions) {
                if (uniqueDownstream.length > 0 || uniqueAffectedTests.length > 0) {
                    breakingIssues.push({
                        severity: '⚠️ Breaking Change',
                        message: `Function changed: ${func} (may break callers)`,
                        line: 0,
                        category: 'Function Impact',
                        file: result.filePath,
                        recommendedFixes: [
                            `Find all call sites of ${func}() and update them`,
                            'Maintain backward compatibility by adding overloads',
                            'Add parameter defaults if possible',
                            'Update function signature documentation',
                            'Run tests for all callers to verify compatibility'
                        ]
                    });
                }
            }
        }
        
        if (uniqueChangedClasses.length > 0) {
            // Only count if there are downstream components (indicating other code depends on it)
            for (const cls of uniqueChangedClasses) {
                if (uniqueDownstream.length > 0 || uniqueAffectedTests.length > 0) {
                    breakingIssues.push({
                        severity: '⚠️ Breaking Change',
                        message: `Class changed: ${cls} (may break dependents)`,
                        line: 0,
                        category: 'Class Impact',
                        file: result.filePath,
                        recommendedFixes: [
                            `Find all usages of ${cls} class and verify compatibility`,
                            'Maintain backward compatibility by preserving existing methods/properties',
                            'Add deprecation warnings before removing features',
                            'Update class documentation with migration guide',
                            'Run tests for all dependent classes'
                        ]
                    });
                }
            }
        }
        
        const seenIssues = new Set<string>();
        const dedupedIssues: typeof breakingIssues = [];

        for (const issue of breakingIssues) {
            const key = `${issue.category}|${issue.message}|${issue.file || ''}`;
            if (seenIssues.has(key)) {
                continue;
            }
            seenIssues.add(key);
            dedupedIssues.push(issue);
        }

        return dedupedIssues;
    }

    private async getDetailItems(detailElement: ImpactViewItem): Promise<ImpactViewItem[]> {
        const items: ImpactViewItem[] = [];
        const context = detailElement.analysisResult || {};
        const inferredResult: ImpactAnalysisResult | undefined = context.result
            || context.analysisResult
            || (typeof context.filePath === 'string' ? context as ImpactAnalysisResult : undefined)
            || (detailElement.filePath ? this.latestEntriesByFile.get(detailElement.filePath)?.result : undefined);

        if (detailElement.type === 'ci-root') {
            return this.getCiBuildItems();
        }

        if (detailElement.type === 'ci-build') {
            const build: CiBuildEntry | undefined = detailElement.analysisResult?.build;
            if (!build) {
                return items;
            }
            return this.createCiBuildDetailItems(build);
        }

        if (detailElement.type === 'ci-build-tests') {
            const build: CiBuildEntry | undefined = detailElement.analysisResult?.build;
            if (!build) {
                return items;
            }
            return this.createCiTestItems(build);
        }

        if (detailElement.type === 'ci-build-tests-category') {
            const { build, filter } = detailElement.analysisResult || {};
            if (build) {
                return this.createCiTestItemsForFilter(build, filter);
            }
        } else if (detailElement.type === 'ci-test') {
            const run: CiTestRunEntry | undefined = detailElement.analysisResult?.run;
            if (!run) {
                return items;
            }
            return this.createCiTestDetailItems(run);
        }

        if (detailElement.type === 'ci-test-stack') {
            const stackTrace: string | undefined = detailElement.analysisResult?.stackTrace;
            if (!stackTrace) {
                return items;
            }
            return this.createCiStackItems(stackTrace);
        }

        if (detailElement.type === 'ci-test-metadata') {
            const metadata: Record<string, any> | undefined = detailElement.analysisResult?.metadata;
            if (!metadata) {
                return items;
            }
            return this.createCiMetadataItems(metadata);
        }

        if (!inferredResult && detailElement.type !== 'delta-summary' && detailElement.type !== 'test-result-error' && detailElement.type !== 'test-result-stack' && detailElement.type !== 'test-result-output') {
            return items;
        }

        // What Will Break - Show breaking issues
        const result = inferredResult;

        if (detailElement.type === 'breaking-issues') {
            // Check for TypeScript breaking changes first
            const breakingChanges = context.breakingChanges || [];
            const breakingIssues = context.breakingIssues || [];
            const filePath = context.result?.filePath || inferredResult?.filePath || '';
            const riskLevel = context.riskLevel || 'medium';
            
            // DEBUG: Log what we're working with in detail view
            console.log(`[UI Detail] Breaking changes: ${breakingChanges.length}, Breaking issues: ${breakingIssues.length}`);
            
            if (breakingChanges.length > 0) {
                // Display TypeScript breaking changes in enhanced format
                for (let i = 0; i < breakingChanges.length; i++) {
                    const change = breakingChanges[i];
                    
                    // Build the breaking change node with proper label and description
                    const changeItem = new ImpactViewItem(
                        this.formatBreakingChangeNodeLabel(change),
                        'breaking-change',
                        vscode.TreeItemCollapsibleState.Collapsed
                    );
                    changeItem.description = this.formatBreakingChangeNodeDescription(change);
                    changeItem.tooltip = this.buildBreakingChangeTooltip(change, filePath);
                    changeItem.analysisResult = { breakingChange: change, filePath, index: i, result };
                    
                    // Color code based on risk - use warning (yellow) for medium, error (red) only for high
                    const isHighRisk = this.isCriticalRule(change.ruleId);
                    const changeRiskColor = isHighRisk 
                        ? new vscode.ThemeColor('errorForeground')
                        : new vscode.ThemeColor('warningForeground');
                    const changeIcon = isHighRisk ? 'error' : 'warning';
                    changeItem.iconPath = new vscode.ThemeIcon(changeIcon, changeRiskColor);
                    
                    items.push(changeItem);
                }
            } else if (breakingIssues.length === 0) {
                const noIssuesItem = new ImpactViewItem(
                    '✅ No breaking issues detected',
                    'breaking-issue',
                    vscode.TreeItemCollapsibleState.None
                );
                noIssuesItem.iconPath = new vscode.ThemeIcon('check');
                items.push(noIssuesItem);
            } else {
                // Fallback to legacy breaking issues display
                // Group by category
                const byCategory = new Map<string, typeof breakingIssues>();
                for (const issue of breakingIssues) {
                    if (!byCategory.has(issue.category)) {
                        byCategory.set(issue.category, []);
                    }
                    byCategory.get(issue.category)!.push(issue);
                }
                
                // Show issues grouped by category
                for (const [category, categoryIssues] of byCategory.entries()) {
                    const categoryItem = new ImpactViewItem(
                        `${category} (${categoryIssues.length})`,
                        'breaking-category',
                        vscode.TreeItemCollapsibleState.Collapsed
                    );
                    
                    // Use appropriate icons based on category type (matching main tree icons)
                    if (category === 'Function Impact') {
                        categoryItem.iconPath = new vscode.ThemeIcon('symbol-function');
                    } else if (category === 'Test Impact') {
                        categoryItem.iconPath = new vscode.ThemeIcon('beaker');
                    } else if (category === 'Class Impact') {
                        categoryItem.iconPath = new vscode.ThemeIcon('symbol-class');
                    } else if (category === 'Downstream Impact') {
                        categoryItem.iconPath = new vscode.ThemeIcon('arrow-down');
                    } else {
                        categoryItem.iconPath = new vscode.ThemeIcon('warning');
                    }
                    
                    categoryItem.analysisResult = { issues: categoryIssues, filePath, category };
                    items.push(categoryItem);
                }
            }
        } else if (detailElement.type === 'breaking-category') {
            // Show issues in this category
            const issues = context.issues || [];
            const filePath = context.filePath || inferredResult?.filePath || '';
            const categoryName = context.category || '';
            
            // For Test Impact category, add a "Run All Tests" option at the top
            if (categoryName === 'Test Impact' && issues.length > 0) {
                const testFiles = issues
                    .filter((issue: any) => issue.file && issue.category === 'Test Impact')
                    .map((issue: any) => issue.file)
                    .filter((file: string | undefined, index: number, self: string[]) => 
                        file && self.indexOf(file) === index
                    ) as string[];
                
                if (testFiles.length > 0) {
                    const runAllTestsItem = new ImpactViewItem(
                        `▶️ Run All Tests (${testFiles.length})`,
                        'run-tests',
                        vscode.TreeItemCollapsibleState.None
                    );
                    runAllTestsItem.iconPath = new vscode.ThemeIcon('play');
                    runAllTestsItem.description = 'Run all affected tests';
                    runAllTestsItem.analysisResult = { testFiles, category: 'Test Impact' };
                    runAllTestsItem.command = {
                        command: 'impactAnalyzer.runAffectedTests',
                        title: 'Run All Tests',
                        arguments: [testFiles]
                    };
                    items.push(runAllTestsItem);
                    
                    // Add separator
                    const separatorItem = new ImpactViewItem(
                        '─'.repeat(40),
                        'separator',
                        vscode.TreeItemCollapsibleState.None
                    );
                    separatorItem.description = '';
                    items.push(separatorItem);
                }
            }
            
            for (const issue of issues) {
                // For impact issues (no line number), show file path instead
                const label = issue.line > 0 
                    ? `Line ${issue.line}: ${issue.message}`
                    : `${issue.message}${issue.file ? ` (${require('path').basename(issue.file)})` : ''}`;
                
                // Check if this issue has recommended fixes
                const hasFixes = issue.recommendedFixes && issue.recommendedFixes.length > 0;
                
                // For Test Impact issues, make them collapsible to show test results and "Run Test" option
                const isTestImpact = issue.category === 'Test Impact';
                const hasTestResult = isTestImpact && issue.file && this.testResults.has(issue.file);
                const collapsibleState = (isTestImpact && hasTestResult) || hasFixes
                    ? vscode.TreeItemCollapsibleState.Collapsed
                    : isTestImpact || hasFixes
                    ? vscode.TreeItemCollapsibleState.Collapsed
                    : vscode.TreeItemCollapsibleState.None;
                
                const issueItem = new ImpactViewItem(
                    label,
                    'breaking-issue',
                    collapsibleState
                );
                
                // Use appropriate icons based on category type
                if (issue.category === 'Test Impact') {
                    // Show test result status icon if test has been run
                    const testResult = issue.file ? this.testResults.get(issue.file) : undefined;
                    if (testResult) {
                        issueItem.iconPath = new vscode.ThemeIcon(
                            testResult.status === 'passed' ? 'check' : 
                            testResult.status === 'failed' ? 'error' : 
                            testResult.status === 'skipped' ? 'circle-slash' : 'warning'
                        );
                        issueItem.description = `${testResult.status.toUpperCase()} (${testResult.duration}ms)`;
                    } else {
                        issueItem.iconPath = new vscode.ThemeIcon('beaker');
                        issueItem.description = `${issue.severity} - ${issue.category}`;
                    }
                } else if (issue.category === 'Function Impact') {
                    issueItem.iconPath = new vscode.ThemeIcon('symbol-function');
                    issueItem.description = `${issue.severity} - ${issue.category}`;
                } else if (issue.category === 'Class Impact') {
                    issueItem.iconPath = new vscode.ThemeIcon('symbol-class');
                    issueItem.description = `${issue.severity} - ${issue.category}`;
                } else if (issue.category === 'Downstream Impact') {
                    issueItem.iconPath = new vscode.ThemeIcon('arrow-down');
                    issueItem.description = `${issue.severity} - ${issue.category}`;
                } else {
                    issueItem.iconPath = new vscode.ThemeIcon('error');
                    issueItem.description = `${issue.severity} - ${issue.category}`;
                }
                
                issueItem.analysisResult = { issue, filePath };
                
                // For issues with line numbers, add navigation command
                if (issue.line > 0 && (issue.file || filePath)) {
                    const targetPath = issue.file || filePath;
                    issueItem.command = {
                        command: 'vscode.open',
                        title: 'Go to Line',
                        arguments: [
                            vscode.Uri.file(targetPath),
                            { selection: new vscode.Range(issue.line - 1, 0, issue.line - 1, 0) }
                        ]
                    };
                } else if (issue.file) {
                    // For impact issues with file path, open file
                    issueItem.command = {
                        command: 'vscode.open',
                        title: 'Open File',
                        arguments: [vscode.Uri.file(issue.file)]
                    };
                }
                
                items.push(issueItem);
            }
        } else if (detailElement.type === 'breaking-change') {
            // Display breaking change with Evidence/Impact/Fixes/Location children
            const breakingChange = context.breakingChange;
            const filePath = context.filePath || inferredResult?.filePath || '';
            
            if (!breakingChange) {
                return items;
            }

            // Evidence section
            const evidence = new ImpactViewItem(
                'Evidence',
                'breaking-change-evidence',
                vscode.TreeItemCollapsibleState.None
            );
            evidence.iconPath = new vscode.ThemeIcon('note');
            evidence.tooltip = this.buildBreakingChangeDetailTooltip(breakingChange);
            evidence.analysisResult = { breakingChange, filePath };
            items.push(evidence);

            // Impact section - get data from breaking change or fallback to result
            const result = context.result || inferredResult;
            const impactedFiles = breakingChange.impactedFiles || (result ? (result.downstreamComponents || []) : []);
            const impactedTests = breakingChange.impactedTests || (result ? (result.affectedTests || []) : []);
            const hasImpacts = (impactedFiles.length > 0) || (impactedTests.length > 0) || (breakingChange.symbolKind === 'function' || breakingChange.symbolKind === 'method');
            
            if (hasImpacts) {
                const impact = new ImpactViewItem(
                    'Impact',
                    'breaking-change-impact',
                    vscode.TreeItemCollapsibleState.Collapsed
                );
                impact.description = this.formatImpactSummary(breakingChange);
                impact.iconPath = new vscode.ThemeIcon('arrow-down');
                impact.analysisResult = { breakingChange, filePath, result };
                items.push(impact);
            }

            // Recommended Fixes section
            const fixes = new ImpactViewItem(
                'Recommended Fixes',
                'breaking-change-actions',
                vscode.TreeItemCollapsibleState.Collapsed
            );
            fixes.description = `${this.getRecommendedActions(breakingChange).length} suggestion(s)`;
            fixes.iconPath = new vscode.ThemeIcon('lightbulb');
            fixes.analysisResult = { breakingChange, filePath };
            items.push(fixes);

            // Location (if available)
            if (breakingChange.span && breakingChange.span.start >= 0) {
                const location = new ImpactViewItem(
                    'Location',
                    'breaking-change-location',
                    vscode.TreeItemCollapsibleState.None
                );
                location.iconPath = new vscode.ThemeIcon('location');
                const line = this.getLineNumberFromSpan(breakingChange.span, filePath);
                location.description = line > 0 ? `Line ${line}` : `Position ${breakingChange.span.start}`;
                location.analysisResult = { breakingChange, filePath, line };
                if (line > 0) {
                    location.command = {
                        command: 'vscode.open',
                        title: 'Go to Line',
                        arguments: [
                            vscode.Uri.file(filePath),
                            { selection: new vscode.Range(line - 1, 0, line - 1, 0) }
                        ]
                    };
                }
                items.push(location);
            }

            return items;
        } else if (detailElement.type === 'breaking-change-impact') {
            // Show impact children: Downstream, Tests, Usages
            const breakingChange = context.breakingChange;
            const filePath = context.filePath || '';
            const result = context.result || inferredResult;

            if (!breakingChange) {
                return items;
            }

            // Get impacted files - from breaking change or fallback to result
            const impactedFiles = breakingChange.impactedFiles || (result ? (result.downstreamComponents || []) : []);
            console.log(`[UI Impact] Impacted files: ${impactedFiles.length}, from breakingChange: ${breakingChange.impactedFiles?.length || 0}, from result: ${result?.downstreamComponents?.length || 0}`);
            
            if (impactedFiles && impactedFiles.length > 0) {
                const filesItem = new ImpactViewItem(
                    `📦 Downstream Impact (${impactedFiles.length})`,
                    'breaking-change-impact-files',
                    vscode.TreeItemCollapsibleState.Collapsed
                );
                filesItem.iconPath = new vscode.ThemeIcon('file');
                filesItem.analysisResult = { breakingChange, filePath, impactedFiles, result };
                items.push(filesItem);
            }

            // Get impacted tests - from breaking change or fallback to result
            const impactedTests = breakingChange.impactedTests || (result ? (result.affectedTests || []) : []);
            console.log(`[UI Impact] Impacted tests: ${impactedTests.length}, from breakingChange: ${breakingChange.impactedTests?.length || 0}, from result: ${result?.affectedTests?.length || 0}`);
            
            if (impactedTests && impactedTests.length > 0) {
                const testsItem = new ImpactViewItem(
                    `🧪 Test Impact (${impactedTests.length})`,
                    'breaking-change-impact-tests',
                    vscode.TreeItemCollapsibleState.Collapsed
                );
                testsItem.iconPath = new vscode.ThemeIcon('beaker');
                testsItem.analysisResult = { breakingChange, filePath, impactedTests, result };
                items.push(testsItem);
            }

            if (breakingChange.symbolKind === 'function' || breakingChange.symbolKind === 'method') {
                const usageItem = new ImpactViewItem(
                    `🧩 Function Impact: ${breakingChange.symbolName}() callers may break`,
                    'breaking-change-impact-usage',
                    vscode.TreeItemCollapsibleState.None
                );
                usageItem.iconPath = new vscode.ThemeIcon('symbol-function');
                items.push(usageItem);
            }

            return items;
        } else if (detailElement.type === 'breaking-change-impact-files') {
            // List impacted files with navigation
            const breakingChange = context.breakingChange;
            const filePath = context.filePath || '';
            const result = context.result || inferredResult;
            const locations = breakingChange?.impactedFileLocations || [];
            
            // Get impacted files from context or fallback to result
            const impactedFiles = context.impactedFiles || breakingChange?.impactedFiles || (result ? (result.downstreamComponents || []) : []);
            
            for (const impactedFile of impactedFiles) {
                const location = locations.find((loc: { filePath: string; line: number; column: number }) => loc.filePath === impactedFile);
                
                const fileItem = new ImpactViewItem(
                    path.basename(impactedFile),
                    'breaking-change-impact-files',
                    vscode.TreeItemCollapsibleState.None
                );
                fileItem.description = location 
                    ? `Line ${location.line}` 
                    : path.relative(path.dirname(filePath), impactedFile);
                fileItem.iconPath = new vscode.ThemeIcon('file');
                
                if (location && location.line > 0) {
                    fileItem.command = {
                        command: 'vscode.open',
                        title: 'Go to Usage',
                        arguments: [
                            vscode.Uri.file(impactedFile),
                            { 
                                selection: new vscode.Range(
                                    location.line - 1, 
                                    location.column - 1, 
                                    location.line - 1, 
                                    location.column - 1
                                )
                            }
                        ]
                    };
                } else {
                    fileItem.command = {
                        command: 'vscode.open',
                        title: 'Open File',
                        arguments: [vscode.Uri.file(impactedFile)]
                    };
                }
                items.push(fileItem);
            }
            return items;
        } else if (detailElement.type === 'breaking-change-impact-tests') {
            // List impacted tests
            const breakingChange = context.breakingChange;
            const filePath = context.filePath || '';
            const result = context.result || inferredResult;

            // Get impacted tests from context or fallback to result
            const impactedTests = context.impactedTests || breakingChange?.impactedTests || (result ? (result.affectedTests || []) : []);

            for (const testFile of impactedTests) {
                const testItem = new ImpactViewItem(
                    path.basename(testFile),
                    'breaking-change-impact-tests',
                    vscode.TreeItemCollapsibleState.None
                );
                testItem.description = path.relative(path.dirname(filePath), testFile);
                testItem.iconPath = new vscode.ThemeIcon('beaker');
                testItem.command = {
                    command: 'vscode.open',
                    title: 'Open Test',
                    arguments: [vscode.Uri.file(testFile)]
                };
                items.push(testItem);
            }
            return items;
        } else if (detailElement.type === 'breaking-change-actions') {
            // Show recommended actions
            const breakingChange = context.breakingChange;
            const actions = this.getRecommendedActions(breakingChange);
            
            for (const action of actions) {
                const actionItem = new ImpactViewItem(
                    `• ${action}`,
                    'breaking-change-actions',
                    vscode.TreeItemCollapsibleState.None
                );
                actionItem.iconPath = new vscode.ThemeIcon('lightbulb');
                items.push(actionItem);
            }
            return items;
        } else if (detailElement.type === 'breaking-change-evidence') {
            // Show evidence - description only, no before/after highlights
            const breakingChange = context.breakingChange;
            const evidenceItem = new ImpactViewItem(
                this.formatBreakingChangeDescription(breakingChange),
                'breaking-change-evidence',
                vscode.TreeItemCollapsibleState.None
            );
            evidenceItem.iconPath = new vscode.ThemeIcon('note');
            evidenceItem.tooltip = this.buildBreakingChangeDetailTooltip(breakingChange);
            items.push(evidenceItem);
            return items;
        } else if (detailElement.type === 'ts-breaking-change') {
            // Legacy handler - keep for backward compatibility but shouldn't be used
            const breakingChange = context.breakingChange;
            const filePath = context.filePath || inferredResult?.filePath || '';
            
            if (!breakingChange) {
                return items;
            }

            // Breaking Change section - use description only, no before/after highlights
            const changeDesc = this.formatBreakingChangeDescription(breakingChange);
            
            const changeItem = new ImpactViewItem(
                'Breaking Change',
                'ts-breaking-detail',
                vscode.TreeItemCollapsibleState.None
            );
            changeItem.description = changeDesc;
            changeItem.tooltip = this.buildBreakingChangeDetailTooltip(breakingChange);
            changeItem.analysisResult = { breakingChange, filePath, section: 'change' };
            changeItem.iconPath = new vscode.ThemeIcon('edit');
            items.push(changeItem);

            // Impact section
            const impactItem = new ImpactViewItem(
                'Impact',
                'ts-breaking-detail',
                vscode.TreeItemCollapsibleState.Collapsed
            );
            impactItem.description = this.formatImpactSummary(breakingChange);
            impactItem.analysisResult = { breakingChange, filePath, section: 'impact' };
            impactItem.iconPath = new vscode.ThemeIcon('arrow-down');
            items.push(impactItem);

            // Recommended Action section
            const actionItem = new ImpactViewItem(
                'Recommended Action',
                'ts-breaking-detail',
                vscode.TreeItemCollapsibleState.Collapsed
            );
            actionItem.description = `${this.getRecommendedActions(breakingChange).length} suggestion(s)`;
            actionItem.analysisResult = { breakingChange, filePath, section: 'actions' };
            actionItem.iconPath = new vscode.ThemeIcon('lightbulb');
            items.push(actionItem);

            // Location (if available)
            if (breakingChange.span && breakingChange.span.start > 0) {
                const locationItem = new ImpactViewItem(
                    'Location',
                    'ts-breaking-detail',
                    vscode.TreeItemCollapsibleState.None
                );
                const lineNumber = this.getLineNumberFromSpan(breakingChange.span, filePath);
                locationItem.description = lineNumber > 0 ? `Line ${lineNumber}` : `Position ${breakingChange.span.start}`;
                locationItem.analysisResult = { breakingChange, filePath, section: 'location' };
                locationItem.iconPath = new vscode.ThemeIcon('location');
                if (lineNumber > 0) {
                    locationItem.command = {
                        command: 'vscode.open',
                        title: 'Go to Line',
                        arguments: [
                            vscode.Uri.file(filePath),
                            { selection: new vscode.Range(lineNumber - 1, 0, lineNumber - 1, 0) }
                        ]
                    };
                }
                items.push(locationItem);
            }
        } else if (detailElement.type === 'ts-breaking-detail') {
            // Show details for each section
            const breakingChange = context.breakingChange;
            const section = context.section;
            const filePath = context.filePath || '';

            if (!breakingChange || !section) {
                return items;
            }

            if (section === 'impact') {
                // Show impacted files - labeled as "Downstream Impact" not "will break"
                if (breakingChange.impactedFiles && breakingChange.impactedFiles.length > 0) {
                    const filesItem = new ImpactViewItem(
                        `📦 Downstream Impact (${breakingChange.impactedFiles.length})`,
                        'ts-breaking-detail',
                        vscode.TreeItemCollapsibleState.Collapsed
                    );
                    filesItem.iconPath = new vscode.ThemeIcon('file');
                    filesItem.analysisResult = { breakingChange, filePath, section: 'impact-files' };
                    items.push(filesItem);
                }

                // Show impacted tests - labeled as "Test Impact" not "will break"
                if (breakingChange.impactedTests && breakingChange.impactedTests.length > 0) {
                    const testsItem = new ImpactViewItem(
                        `🧪 Test Impact (${breakingChange.impactedTests.length})`,
                        'ts-breaking-detail',
                        vscode.TreeItemCollapsibleState.Collapsed
                    );
                    testsItem.iconPath = new vscode.ThemeIcon('beaker');
                    testsItem.analysisResult = { breakingChange, filePath, section: 'impact-tests' };
                    items.push(testsItem);
                }

                // Show affected functions - labeled as "Function Impact" not "will break"
                if (breakingChange.symbolKind === 'function' || breakingChange.symbolKind === 'method') {
                    const funcItem = new ImpactViewItem(
                        `🧩 Function Impact: ${breakingChange.symbolName}() callers may break`,
                        'ts-breaking-detail',
                        vscode.TreeItemCollapsibleState.None
                    );
                    funcItem.iconPath = new vscode.ThemeIcon('symbol-function');
                    items.push(funcItem);
                }
            } else if (section === 'impact-files') {
                // List impacted files with navigation to usage location
                const impactedFiles = breakingChange.impactedFiles || [];
                const locations = breakingChange.impactedFileLocations || [];
                
                for (let i = 0; i < impactedFiles.length; i++) {
                    const impactedFile = impactedFiles[i];
                    const location = locations.find((loc: { filePath: string; line: number; column: number }) => loc.filePath === impactedFile);
                    
                    const fileItem = new ImpactViewItem(
                        path.basename(impactedFile),
                        'ts-breaking-detail',
                        vscode.TreeItemCollapsibleState.None
                    );
                    fileItem.description = location 
                        ? `Line ${location.line}` 
                        : path.relative(path.dirname(filePath), impactedFile);
                    fileItem.iconPath = new vscode.ThemeIcon('file');
                    
                    // Navigate to the usage location if available
                    if (location && location.line > 0) {
                        fileItem.command = {
                            command: 'vscode.open',
                            title: 'Go to Usage',
                            arguments: [
                                vscode.Uri.file(impactedFile),
                                { 
                                    selection: new vscode.Range(
                                        location.line - 1, 
                                        location.column - 1, 
                                        location.line - 1, 
                                        location.column - 1
                                    )
                                }
                            ]
                        };
                    } else {
                        // Fallback: just open the file
                        fileItem.command = {
                            command: 'vscode.open',
                            title: 'Open File',
                            arguments: [vscode.Uri.file(impactedFile)]
                        };
                    }
                    items.push(fileItem);
                }
            } else if (section === 'impact-tests') {
                // List impacted tests
                for (const testFile of breakingChange.impactedTests || []) {
                    const testItem = new ImpactViewItem(
                        path.basename(testFile),
                        'ts-breaking-detail',
                        vscode.TreeItemCollapsibleState.None
                    );
                    testItem.description = path.relative(path.dirname(filePath), testFile);
                    testItem.iconPath = new vscode.ThemeIcon('beaker');
                    testItem.command = {
                        command: 'vscode.open',
                        title: 'Open Test',
                        arguments: [vscode.Uri.file(testFile)]
                    };
                    items.push(testItem);
                }
            } else if (section === 'actions') {
                // Show recommended actions
                const actions = this.getRecommendedActions(breakingChange);
                for (const action of actions) {
                    const actionItem = new ImpactViewItem(
                        `• ${action}`,
                        'ts-breaking-detail',
                        vscode.TreeItemCollapsibleState.None
                    );
                    actionItem.iconPath = new vscode.ThemeIcon('lightbulb');
                    items.push(actionItem);
                }
            }
        } else if (detailElement.type === 'delta-summary') {
            const delta: ImpactDeltaSummary | undefined = context.delta;
            const deltaResult: ImpactAnalysisResult | undefined = context.result || inferredResult;
            if (!delta || !this.deltaHasChanges(delta)) {
                return items;
            }

            const deltaSections: Array<{ title: string; added: string[]; removed: string[]; icon: string; type: string; }> = [
                { title: 'Functions', added: delta.newFunctions, removed: delta.removedFunctions, icon: 'symbol-function', type: 'delta-functions' },
                { title: 'Classes', added: delta.newClasses, removed: delta.removedClasses, icon: 'symbol-class', type: 'delta-classes' },
                { title: 'Tests', added: delta.newTests, removed: delta.removedTests, icon: 'beaker', type: 'delta-tests' },
                { title: 'Downstream', added: delta.newDownstream, removed: delta.removedDownstream, icon: 'arrow-down', type: 'delta-downstream' }
            ];

            for (const section of deltaSections) {
                if (section.added.length === 0 && section.removed.length === 0) {
                    continue;
                }

                const sectionLabelParts: string[] = [section.title];
                if (section.added.length > 0) {
                    sectionLabelParts.push(`+${section.added.length}`);
                }
                if (section.removed.length > 0) {
                    sectionLabelParts.push(`-${section.removed.length}`);
                }

                const sectionItem = new ImpactViewItem(
                    sectionLabelParts.join(' '),
                    'delta-section',
                    vscode.TreeItemCollapsibleState.Collapsed
                );
                sectionItem.iconPath = new vscode.ThemeIcon(section.icon);
                sectionItem.analysisResult = {
                    added: section.added,
                    removed: section.removed,
                    result: deltaResult,
                    label: section.title
                };
                items.push(sectionItem);
            }
        } else if (detailElement.type === 'delta-section') {
            const added: string[] = context.added || [];
            const removed: string[] = context.removed || [];
            const label: string = context.label || 'Changes';

            if (added.length === 0 && removed.length === 0) {
                return items;
            }

            if (added.length > 0) {
                const addedHeader = new ImpactViewItem(
                    `Added (${added.length})`,
                    'delta-change',
                    vscode.TreeItemCollapsibleState.Collapsed
                );
                addedHeader.iconPath = new vscode.ThemeIcon('diff-added');
                addedHeader.analysisResult = { items: added, changeType: 'added', label };
                items.push(addedHeader);
            }

            if (removed.length > 0) {
                const removedHeader = new ImpactViewItem(
                    `Removed (${removed.length})`,
                    'delta-change',
                    vscode.TreeItemCollapsibleState.Collapsed
                );
                removedHeader.iconPath = new vscode.ThemeIcon('diff-removed');
                removedHeader.analysisResult = { items: removed, changeType: 'removed', label };
                items.push(removedHeader);
            }
        } else if (detailElement.type === 'delta-change') {
            const changeItems: string[] = context.items || [];
            const changeType: string = context.changeType || 'changed';
            const changeIcon = changeType === 'added' ? 'diff-added' : 'diff-removed';

            for (const item of changeItems) {
                const changeItem = new ImpactViewItem(
                    item,
                    'delta-entry',
                    vscode.TreeItemCollapsibleState.None
                );
                changeItem.iconPath = new vscode.ThemeIcon(changeIcon);
                items.push(changeItem);
            }

            return items;
        }

        const resultOptionalTypes = new Set<string>([
            'test-result-error',
            'test-result-stack',
            'test-result-output',
            'test-result-error-line',
            'test-result-stack-line',
            'test-result-output-line',
            'test-result-more'
        ]);

        if (!result && !resultOptionalTypes.has(detailElement.type)) {
            return items;
        }

        const safeResult = (result || {}) as ImpactAnalysisResult;

        if (detailElement.type === 'breaking-issue') {
            // Show recommended fixes for this breaking issue
            const issue = context.issue;
            const filePath = context.filePath || safeResult.filePath || '';
            
            // For Test Impact issues, show test results if available, otherwise show "Run Test" option
            if (issue && issue.category === 'Test Impact' && issue.file) {
                const testResult = this.testResults.get(issue.file);
                
                if (testResult) {
                    // Show test results as subtree
                    const statusIcon = testResult.status === 'passed' ? '✅' : 
                                      testResult.status === 'failed' ? '❌' : 
                                      testResult.status === 'skipped' ? '⏭️' : '⚠️';
                    
                    const statusItem = new ImpactViewItem(
                        `${statusIcon} Status: ${testResult.status.toUpperCase()}`,
                        'test-result-status',
                        vscode.TreeItemCollapsibleState.None
                    );
                    statusItem.iconPath = new vscode.ThemeIcon(
                        testResult.status === 'passed' ? 'check' : 
                        testResult.status === 'failed' ? 'error' : 
                        testResult.status === 'skipped' ? 'circle-slash' : 'warning'
                    );
                    statusItem.description = `${testResult.duration}ms`;
                    items.push(statusItem);
                    
                    if (testResult.errorMessage) {
                        const errorItem = new ImpactViewItem(
                            `Error: ${testResult.errorMessage.substring(0, 100)}${testResult.errorMessage.length > 100 ? '...' : ''}`,
                            'test-result-error',
                            vscode.TreeItemCollapsibleState.Collapsed
                        );
                        errorItem.iconPath = new vscode.ThemeIcon('error');
                        errorItem.description = 'Click to expand';
                        errorItem.analysisResult = { errorMessage: testResult.errorMessage, stackTrace: testResult.stackTrace };
                        items.push(errorItem);
                    }
                    
                    if (testResult.stackTrace) {
                        const stackItem = new ImpactViewItem(
                            'Stack Trace',
                            'test-result-stack',
                            vscode.TreeItemCollapsibleState.Collapsed
                        );
                        stackItem.iconPath = new vscode.ThemeIcon('list');
                        stackItem.description = 'Click to expand';
                        stackItem.analysisResult = { stackTrace: testResult.stackTrace };
                        items.push(stackItem);
                    }
                    
                    if (testResult.output) {
                        const outputItem = new ImpactViewItem(
                            'Test Output',
                            'test-result-output',
                            vscode.TreeItemCollapsibleState.Collapsed
                        );
                        outputItem.iconPath = new vscode.ThemeIcon('output');
                        outputItem.description = 'Click to expand';
                        outputItem.analysisResult = { output: testResult.output };
                        items.push(outputItem);
                    }
                    
                    // Add separator before run test option
                    const separatorItem = new ImpactViewItem(
                        '─',
                        'separator',
                        vscode.TreeItemCollapsibleState.None
                    );
                    separatorItem.description = '';
                    items.push(separatorItem);
                }
                
                // Always show "Run Test" option (to re-run or run if not run yet)
                const runTestItem = new ImpactViewItem(
                    testResult ? `🔄 Run Test Again: ${require('path').basename(issue.file)}` : `▶️ Run Test: ${require('path').basename(issue.file)}`,
                    'run-single-test',
                    vscode.TreeItemCollapsibleState.None
                );
                runTestItem.iconPath = new vscode.ThemeIcon('play');
                runTestItem.description = 'Execute this test file';
                runTestItem.analysisResult = { testFile: issue.file };
                runTestItem.command = {
                    command: 'impactAnalyzer.runAffectedTests',
                    title: 'Run Test',
                    arguments: [[issue.file]]
                };
                items.push(runTestItem);
                
                // Add separator if there are also fixes
                if (issue.recommendedFixes && issue.recommendedFixes.length > 0) {
                    const separatorItem2 = new ImpactViewItem(
                        '─',
                        'separator',
                        vscode.TreeItemCollapsibleState.None
                    );
                    separatorItem2.description = '';
                    items.push(separatorItem2);
                }
            }
            
            if (issue && issue.recommendedFixes && issue.recommendedFixes.length > 0) {
                const fixesItem = new ImpactViewItem(
                    `Recommended Fixes (${issue.recommendedFixes.length})`,
                    'breaking-fixes',
                    vscode.TreeItemCollapsibleState.Collapsed
                );
                fixesItem.iconPath = new vscode.ThemeIcon('lightbulb');
                fixesItem.description = 'Click to view';
                fixesItem.analysisResult = { fixes: issue.recommendedFixes };
                items.push(fixesItem);
            }
        } else if (detailElement.type === 'test-result-error') {
            // Show full error message
            const errorMessage = detailElement.analysisResult.errorMessage || '';
            const errorLines = errorMessage.split('\n').filter((line: string) => line.trim().length > 0);
            for (const line of errorLines) {
                const errorLineItem = new ImpactViewItem(
                    line.substring(0, 200),
                    'test-result-error-line',
                    vscode.TreeItemCollapsibleState.None
                );
                errorLineItem.iconPath = new vscode.ThemeIcon('circle-small');
                items.push(errorLineItem);
            }
        } else if (detailElement.type === 'test-result-stack') {
            // Show stack trace
            const stackTrace = detailElement.analysisResult.stackTrace || '';
            const stackLines = stackTrace.split('\n').filter((line: string) => line.trim().length > 0);
            for (const line of stackLines) {
                const stackLineItem = new ImpactViewItem(
                    line.substring(0, 200),
                    'test-result-stack-line',
                    vscode.TreeItemCollapsibleState.None
                );
                stackLineItem.iconPath = new vscode.ThemeIcon('circle-small');
                items.push(stackLineItem);
            }
        } else if (detailElement.type === 'test-result-output') {
            // Show test output
            const output = detailElement.analysisResult.output || '';
            const outputLines = output.split('\n').filter((line: string) => line.trim().length > 0);
            // Limit to first 50 lines to avoid overwhelming the UI
            const displayLines = outputLines.slice(0, 50);
            for (const line of displayLines) {
                const outputLineItem = new ImpactViewItem(
                    line.substring(0, 200),
                    'test-result-output-line',
                    vscode.TreeItemCollapsibleState.None
                );
                outputLineItem.iconPath = new vscode.ThemeIcon('circle-small');
                items.push(outputLineItem);
            }
            if (outputLines.length > 50) {
                const moreItem = new ImpactViewItem(
                    `... and ${outputLines.length - 50} more lines (see output channel)`,
                    'test-result-more',
                    vscode.TreeItemCollapsibleState.None
                );
                moreItem.iconPath = new vscode.ThemeIcon('info');
                items.push(moreItem);
            }
        } else if (detailElement.type === 'breaking-fixes') {
            // Show individual fix recommendations
            const fixes = context.fixes || [];
            for (let i = 0; i < fixes.length; i++) {
                const fixItem = new ImpactViewItem(
                    `${i + 1}. ${fixes[i]}`,
                    'fix',
                    vscode.TreeItemCollapsibleState.None
                );
                fixItem.iconPath = new vscode.ThemeIcon('check');
                fixItem.description = 'Recommended fix';
                items.push(fixItem);
            }
        } else if (detailElement.type === 'functions') {
            for (const func of safeResult.changedFunctions || []) {
                const funcItem = new ImpactViewItem(
                    func,
                    'function',
                    vscode.TreeItemCollapsibleState.None
                );
                funcItem.iconPath = new vscode.ThemeIcon('symbol-function');
                items.push(funcItem);
            }
        } else if (detailElement.type === 'classes') {
            for (const cls of safeResult.changedClasses || []) {
                const classItem = new ImpactViewItem(
                    cls,
                    'class',
                    vscode.TreeItemCollapsibleState.None
                );
                classItem.iconPath = new vscode.ThemeIcon('symbol-class');
                items.push(classItem);
            }
        } else if (detailElement.type === 'tests') {
            for (const test of safeResult.affectedTests || []) {
                const testItem = new ImpactViewItem(
                    require('path').basename(test),
                    'test',
                    vscode.TreeItemCollapsibleState.None
                );
                testItem.iconPath = new vscode.ThemeIcon('beaker');
                testItem.description = test;
                items.push(testItem);
            }
        } else if (detailElement.type === 'downstream') {
            for (const component of safeResult.downstreamComponents || []) {
                const componentItem = new ImpactViewItem(
                    require('path').basename(component),
                    'component',
                    vscode.TreeItemCollapsibleState.None
                );
                componentItem.iconPath = new vscode.ThemeIcon('arrow-down');
                componentItem.description = component;
                items.push(componentItem);
            }
        } else if (detailElement.type === 'confidence') {
            // Display all 6 confidence metrics
            const confidenceResult = safeResult.confidenceResult;
            if (!confidenceResult) {
                return items;
            }

            for (const metric of confidenceResult.metrics) {
                const metricItem = new ImpactViewItem(
                    `${metric.statusIcon} ${metric.name}: ${metric.score}/100`,
                    'confidence-metric',
                    metric.weight > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
                );
                metricItem.analysisResult = { metric, confidenceResult, filePath: safeResult.filePath };
                metricItem.iconPath = new vscode.ThemeIcon('circle-outline');
                metricItem.description = `Weight: ${(metric.weight * 100).toFixed(0)}%`;
                metricItem.tooltip = metric.summary;
                
                // Add context value for sorting/grouping
                metricItem.contextValue = `confidence-metric-${metric.name.toLowerCase().replace(/\s+/g, '-')}`;
                items.push(metricItem);
            }
        } else if (detailElement.type === 'confidence-metric') {
            // Show sub-metrics and suggestions for each metric
            const metric = detailElement.analysisResult.metric;
            const filePath = detailElement.analysisResult.filePath || safeResult.filePath || '';
            
            // Summary
            const summaryItem = new ImpactViewItem(
                `Summary: ${metric.summary}`,
                'metric-detail',
                vscode.TreeItemCollapsibleState.None
            );
            summaryItem.iconPath = new vscode.ThemeIcon('info');
            items.push(summaryItem);

            // Issues with line numbers (for Code Correctness sub-metrics)
            if (metric.subMetrics) {
                // Check if this is Code Correctness metric with sub-metrics
                const subMetricKeys = Object.keys(metric.subMetrics);
                const hasLineNumbers = subMetricKeys.some(key => {
                    const subValue = metric.subMetrics[key] as any;
                    return subValue?.issues || subValue?.lineNumbers;
                });
                
                if (hasLineNumbers && metric.name === 'Code Correctness') {
                    // Show sub-metrics with issues
                    for (const [subKey, subValue] of Object.entries(metric.subMetrics)) {
                        const subMetric = subValue as any;
                        if (subMetric && (subMetric.issues || subMetric.lineNumbers)) {
                            const subMetricItem = new ImpactViewItem(
                                `${subKey}: ${subMetric.score}/100`,
                                'sub-metric-detail',
                                (subMetric.issues && subMetric.issues.length > 0) 
                                    ? vscode.TreeItemCollapsibleState.Collapsed 
                                    : vscode.TreeItemCollapsibleState.None
                            );
                            subMetricItem.analysisResult = { 
                                subMetric: subMetric,
                                subMetricName: subKey,
                                filePath: filePath
                            };
                            subMetricItem.iconPath = new vscode.ThemeIcon('circle-outline');
                            subMetricItem.description = `Weight: ${((subMetric.weight || 0) * 100).toFixed(0)}%`;
                            if (subMetric.issues && subMetric.issues.length > 0) {
                                subMetricItem.description += ` | ${subMetric.issues.length} issue(s)`;
                            }
                            items.push(subMetricItem);
                        }
                    }
                } else {
                    // Generic sub-metrics display
                    const subMetricsItem = new ImpactViewItem(
                        'Details',
                        'sub-metrics',
                        vscode.TreeItemCollapsibleState.Collapsed
                    );
                    subMetricsItem.iconPath = new vscode.ThemeIcon('list-unordered');
                    subMetricsItem.analysisResult = { subMetrics: metric.subMetrics };
                    items.push(subMetricsItem);
                }
            }

            // Suggestions
            if (metric.suggestions && metric.suggestions.length > 0) {
                const suggestionsItem = new ImpactViewItem(
                    `Suggestions (${metric.suggestions.length})`,
                    'suggestions',
                    vscode.TreeItemCollapsibleState.Collapsed
                );
                suggestionsItem.iconPath = new vscode.ThemeIcon('lightbulb');
                suggestionsItem.analysisResult = { suggestions: metric.suggestions };
                items.push(suggestionsItem);
            }
        } else if (detailElement.type === 'sub-metric-detail') {
            // Show issues with line numbers for Code Correctness sub-metrics
            const subMetric = detailElement.analysisResult.subMetric;
            const subMetricName = detailElement.analysisResult.subMetricName;
            const filePath = detailElement.analysisResult.filePath;
            
            if (subMetric.issues && Array.isArray(subMetric.issues)) {
                for (const issue of subMetric.issues) {
                    if (typeof issue === 'object' && issue.message && issue.line) {
                        const issueItem = new ImpactViewItem(
                            `Line ${issue.line}: ${issue.message}`,
                            'issue',
                            vscode.TreeItemCollapsibleState.None
                        );
                        issueItem.iconPath = new vscode.ThemeIcon('warning');
                        issueItem.description = `Line ${issue.line}`;
                        issueItem.command = {
                            command: 'vscode.open',
                            title: 'Go to Line',
                            arguments: [
                                vscode.Uri.file(filePath),
                                { selection: new vscode.Range(issue.line - 1, 0, issue.line - 1, 0) }
                            ]
                        };
                        items.push(issueItem);
                    } else if (typeof issue === 'string') {
                        // Fallback for string issues
                        const issueItem = new ImpactViewItem(
                            issue,
                            'issue',
                            vscode.TreeItemCollapsibleState.None
                        );
                        issueItem.iconPath = new vscode.ThemeIcon('warning');
                        items.push(issueItem);
                    }
                }
            }
            
            // Show line numbers if available but no issues
            if ((!subMetric.issues || subMetric.issues.length === 0) && subMetric.lineNumbers) {
                const lineNumbersItem = new ImpactViewItem(
                    `Affected lines: ${subMetric.lineNumbers.join(', ')}`,
                    'metric-detail',
                    vscode.TreeItemCollapsibleState.None
                );
                lineNumbersItem.iconPath = new vscode.ThemeIcon('list-unordered');
                items.push(lineNumbersItem);
            }
        } else if (detailElement.type === 'suggestions') {
            const suggestions = detailElement.analysisResult.suggestions;
            for (let i = 0; i < suggestions.length; i++) {
                const suggestionItem = new ImpactViewItem(
                    `${i + 1}. ${suggestions[i]}`,
                    'suggestion',
                    vscode.TreeItemCollapsibleState.None
                );
                suggestionItem.iconPath = new vscode.ThemeIcon('lightbulb');
                items.push(suggestionItem);
            }
        } else if (detailElement.type === 'sub-metrics') {
            const subMetrics = detailElement.analysisResult.subMetrics;
            for (const [key, value] of Object.entries(subMetrics)) {
                const subMetricItem = new ImpactViewItem(
                    `${key}: ${Array.isArray(value) ? value.length : value}`,
                    'sub-metric',
                    vscode.TreeItemCollapsibleState.None
                );
                subMetricItem.iconPath = new vscode.ThemeIcon('circle-small');
                subMetricItem.description = typeof value === 'object' ? JSON.stringify(value).substring(0, 50) : String(value);
                items.push(subMetricItem);
            }
        } else if (detailElement.type === 'metrics') {
            // Legacy metrics display
            const confidenceItem = new ImpactViewItem(
                `Confidence: ${Math.round((safeResult as any).confidence * 100)}%`,
                'metric',
                vscode.TreeItemCollapsibleState.None
            );
            confidenceItem.iconPath = new vscode.ThemeIcon('graph');
            items.push(confidenceItem);

            const timeItem = new ImpactViewItem(
                `Estimated Test Time: ${(safeResult as any).estimatedTestTime}s`,
                'metric',
                vscode.TreeItemCollapsibleState.None
            );
            timeItem.iconPath = new vscode.ThemeIcon('clock');
            items.push(timeItem);

            const riskItem = new ImpactViewItem(
                `Risk Level: ${(safeResult as any).riskLevel}`,
                'metric',
                vscode.TreeItemCollapsibleState.None
            );
            riskItem.iconPath = new vscode.ThemeIcon('warning');
            items.push(riskItem);
        }

        return items;
    }

    async updateAnalysisResult(result: ImpactAnalysisResult): Promise<void> {
        const previousEntry = this.latestEntriesByFile.get(result.filePath);
        const delta = this.computeDelta(previousEntry?.result, result);
        const entry: ImpactAnalysisEntry = {
            result,
            analyzedAt: Date.now(),
            delta
        };

        this.analysisEntries = this.analysisEntries.filter(existing => existing.result.filePath !== result.filePath);
        this.analysisEntries.unshift(entry);

        if (this.analysisEntries.length > 10) {
            this.analysisEntries = this.analysisEntries.slice(0, 10);
        }

        this.latestEntriesByFile.set(result.filePath, entry);
        this.refresh();
    }

    async updateAnalysisResults(results: ImpactAnalysisResult[]): Promise<void> {
        if (!Array.isArray(results) || results.length === 0) {
            return;
        }

        const newEntries: ImpactAnalysisEntry[] = [];
        const seenFiles = new Set<string>();

        for (const result of results) {
            const previousEntry = this.latestEntriesByFile.get(result.filePath);
            const delta = this.computeDelta(previousEntry?.result, result);
            const entry: ImpactAnalysisEntry = {
                result,
                analyzedAt: Date.now(),
                delta
            };
            newEntries.push(entry);
            this.latestEntriesByFile.set(result.filePath, entry);
            seenFiles.add(result.filePath);
        }

        const remainingEntries = this.analysisEntries.filter(entry => !seenFiles.has(entry.result.filePath));
        this.analysisEntries = [...newEntries, ...remainingEntries].slice(0, 10);
        this.refresh();
    }

    updateCiResults(payload: CiResultsPayload): void {
        this.ciResults = payload.builds;
        this.ciContext = {
            commitHash: payload.commitHash,
            lastUpdated: payload.fetchedAt
        };
        this.refresh();
    }

    getAffectedFiles(): string[] {
        const affectedFiles: string[] = [];
        for (const entry of this.analysisEntries) {
            const result = entry.result;
            if (result.affectedTests) {
                affectedFiles.push(...result.affectedTests);
            }
        }
        return [...new Set(affectedFiles)];
    }

    showHistory(): void {
        vscode.window.showInformationMessage(`Analysis History: ${this.analysisEntries.length} recent analyses`);
    }

    private formatRelativeTime(timestamp: number): string {
        const diffMs = Date.now() - timestamp;
        const absSeconds = Math.round(Math.abs(diffMs) / 1000);

        if (absSeconds < 60) {
            return `${absSeconds}s ago`;
        }

        const absMinutes = Math.round(absSeconds / 60);
        if (absMinutes < 60) {
            return `${absMinutes}m ago`;
        }

        const absHours = Math.round(absMinutes / 60);
        if (absHours < 24) {
            return `${absHours}h ago`;
        }

        const absDays = Math.round(absHours / 24);
        return `${absDays}d ago`;
    }

    private computeDelta(previous: ImpactAnalysisResult | undefined, current: ImpactAnalysisResult): ImpactDeltaSummary | undefined {
        if (!previous) {
            return undefined;
        }

        const functionDelta = this.computeArrayDelta(previous.changedFunctions || [], current.changedFunctions || []);
        const classDelta = this.computeArrayDelta(previous.changedClasses || [], current.changedClasses || []);
        const testDelta = this.computeArrayDelta(previous.affectedTests || [], current.affectedTests || []);
        const downstreamDelta = this.computeArrayDelta(previous.downstreamComponents || [], current.downstreamComponents || []);

        if (
            functionDelta.added.length === 0 && functionDelta.removed.length === 0 &&
            classDelta.added.length === 0 && classDelta.removed.length === 0 &&
            testDelta.added.length === 0 && testDelta.removed.length === 0 &&
            downstreamDelta.added.length === 0 && downstreamDelta.removed.length === 0
        ) {
            return undefined;
        }

        return {
            newFunctions: functionDelta.added,
            removedFunctions: functionDelta.removed,
            newClasses: classDelta.added,
            removedClasses: classDelta.removed,
            newTests: testDelta.added,
            removedTests: testDelta.removed,
            newDownstream: downstreamDelta.added,
            removedDownstream: downstreamDelta.removed
        };
    }

    private computeArrayDelta(previous: string[], current: string[]): { added: string[]; removed: string[] } {
        const previousSet = new Set(previous.map(item => item.trim()));
        const currentSet = new Set(current.map(item => item.trim()));

        const added = Array.from(currentSet).filter(item => !previousSet.has(item));
        const removed = Array.from(previousSet).filter(item => !currentSet.has(item));

        return { added, removed };
    }

    private deltaHasChanges(delta: ImpactDeltaSummary): boolean {
        return (
            delta.newFunctions.length > 0 ||
            delta.removedFunctions.length > 0 ||
            delta.newClasses.length > 0 ||
            delta.removedClasses.length > 0 ||
            delta.newTests.length > 0 ||
            delta.removedTests.length > 0 ||
            delta.newDownstream.length > 0 ||
            delta.removedDownstream.length > 0
        );
    }

    private buildDeltaSummary(delta: ImpactDeltaSummary): string {
        const parts: string[] = [];

        const append = (label: string, added: number, removed: number) => {
            if (added === 0 && removed === 0) {
                return;
            }
            const tokens: string[] = [];
            if (added > 0) {
                tokens.push(`+${added}`);
            }
            if (removed > 0) {
                tokens.push(`-${removed}`);
            }
            parts.push(`${label} ${tokens.join('/')}`);
        };

        append('fn', delta.newFunctions.length, delta.removedFunctions.length);
        append('cls', delta.newClasses.length, delta.removedClasses.length);
        append('tests', delta.newTests.length, delta.removedTests.length);
        append('deps', delta.newDownstream.length, delta.removedDownstream.length);

        return parts.join(', ');
    }

    private buildChangeSummary(result: ImpactAnalysisResult): string {
        const parts: string[] = [];

        if (result.changedFunctions && result.changedFunctions.length > 0) {
            parts.push(`${result.changedFunctions.length} function${result.changedFunctions.length !== 1 ? 's' : ''}`);
        }

        if (result.changedClasses && result.changedClasses.length > 0) {
            parts.push(`${result.changedClasses.length} class${result.changedClasses.length !== 1 ? 'es' : ''}`);
        }

        if (result.affectedTests && result.affectedTests.length > 0) {
            parts.push(`${result.affectedTests.length} test${result.affectedTests.length !== 1 ? 's' : ''}`);
        }

        if (result.downstreamComponents && result.downstreamComponents.length > 0) {
            parts.push(`${result.downstreamComponents.length} downstream`);
        }

        return parts.join(', ');
    }

    private buildFileTooltip(result: ImpactAnalysisResult, entry: ImpactAnalysisEntry): string {
        const lines: string[] = [];
        lines.push(result.filePath);

        const changeSummary = this.buildChangeSummary(result);
        if (changeSummary) {
            lines.push(`Changes: ${changeSummary}`);
        }

        if (result.confidenceResult) {
            lines.push(`Confidence: ${result.confidenceResult.statusIcon} ${result.confidenceResult.total}/100 (${result.confidenceResult.status})`);
        }

        if (entry.delta && this.deltaHasChanges(entry.delta)) {
            lines.push(`Δ ${this.buildDeltaSummary(entry.delta)}`);
        }

        lines.push(`Last analyzed: ${new Date(entry.analyzedAt).toLocaleString()}`);

        return lines.join('\n');
    }

    /**
     * Update test results for a test file
     */
    updateTestResults(testResults: TestResult[]): void {
        for (const result of testResults) {
            this.testResults.set(result.testFile, result);
        }
        this.refresh();
    }

    /**
     * Calculate risk level from breaking changes
     * Severity mapping (non-negotiable):
     * Critical: TSAPI-EXP-001, TSAPI-CLS-001, TSX-CMP-002
     * Medium: TSAPI-FN-001, TSAPI-FN-002, TSAPI-TYP-001, TSAPI-TYP-002, TSX-CMP-001, TSAPI-EXP-002
     */
    private calculateRiskFromBreakingChanges(breakingChanges: any[]): 'low' | 'medium' | 'high' {
        // Critical risk rules
        const criticalRiskRules = ['TSAPI-EXP-001', 'TSAPI-CLS-001', 'TSX-CMP-002'];
        // Medium risk rules
        const mediumRiskRules = ['TSAPI-FN-001', 'TSAPI-FN-002', 'TSAPI-TYP-001', 'TSAPI-TYP-002', 'TSX-CMP-001', 'TSAPI-EXP-002'];
        
        // If any breaking change is critical, return high
        if (breakingChanges.some(c => criticalRiskRules.includes(c.ruleId))) {
            return 'high';
        }
        // If any breaking change is medium, return medium
        if (breakingChanges.some(c => mediumRiskRules.includes(c.ruleId))) {
            return 'medium';
        }
        // Default to low for any other rules
        return 'low';
    }

    /**
     * Check if a rule is critical (high risk)
     */
    private isCriticalRule(ruleId: string): boolean {
        return ['TSAPI-EXP-001', 'TSAPI-CLS-001', 'TSX-CMP-002'].includes(ruleId);
    }

    /**
     * Format breaking change node label with rule title and ID
     */
    private formatBreakingChangeNodeLabel(change: any): string {
        const title = this.getRuleShortTitle(change.ruleId);
        const icon = this.isCriticalRule(change.ruleId) ? '🚨' : '⚠️';
        return `${icon} ${title} — ${change.symbolName} (${change.ruleId})`;
    }

    /**
     * Format breaking change node description
     */
    private formatBreakingChangeNodeDescription(change: any): string {
        // Keep short, put before/after in Evidence node tooltip
        return this.formatBreakingChangeDescription(change);
    }

    /**
     * Get short title for a rule ID
     */
    private getRuleShortTitle(ruleId: string): string {
        const map: Record<string, string> = {
            'TSAPI-EXP-001': 'Export removed',
            'TSAPI-EXP-002': 'Export kind changed',
            'TSAPI-FN-001': 'Signature became stricter',
            'TSAPI-FN-002': 'Parameter type narrowed',
            'TSAPI-CLS-001': 'Class member removed/privatized',
            'TSAPI-TYP-001': 'Required property added/made required',
            'TSAPI-TYP-002': 'Property removed/narrowed',
            'TSX-CMP-001': 'Component props became stricter',
            'TSX-CMP-002': 'Component removed'
        };
        return map[ruleId] || 'Breaking change';
    }

    /**
     * Format breaking change description
     */
    private formatBreakingChangeDescription(change: any): string {
        const symbolKindLabel = this.getSymbolKindLabel(change.symbolKind);
        const changeKindLabel = this.getChangeKindLabel(change.changeKind);
        
        if (change.memberName) {
            return `${symbolKindLabel} \`${change.symbolName}\` ${changeKindLabel}: \`${change.memberName}\``;
        }
        return `${symbolKindLabel} \`${change.symbolName}\` ${changeKindLabel}`;
    }

    /**
     * Get human-readable symbol kind label
     */
    private getSymbolKindLabel(symbolKind: string): string {
        const labels: Record<string, string> = {
            'function': 'Function',
            'class': 'Class',
            'type': 'Type',
            'enum': 'Enum',
            'value': 'Value',
            'component': 'Component',
            'method': 'Method',
            'property': 'Property'
        };
        return labels[symbolKind] || symbolKind;
    }

    /**
     * Get human-readable change kind label
     */
    private getChangeKindLabel(changeKind: string): string {
        const labels: Record<string, string> = {
            'export_removed': 'was removed',
            'export_kind_changed': 'export kind changed',
            'signature_required_param_added': 'parameter became required',
            'signature_param_became_required': 'parameter became required',
            'signature_param_type_narrowed': 'parameter type narrowed',
            'class_member_removed_or_privatised': 'member removed or privatised',
            'type_required_prop_added_or_made_required': 'property became required',
            'type_prop_removed_or_narrowed': 'property removed or narrowed',
            'component_props_stricter': 'props became stricter',
            'component_removed': 'was removed'
        };
        return labels[changeKind] || changeKind;
    }

    /**
     * Format breaking change description with before/after
     */
    private formatBreakingChangeWithBeforeAfter(change: any): string {
        if (change.before && change.after) {
            // For signature changes, show the actual before/after in a readable format
            if (change.changeKind === 'signature_required_param_added' || 
                change.changeKind === 'signature_param_became_required' ||
                change.changeKind === 'signature_param_type_narrowed') {
                // Extract parameter name from before/after if available
                const beforeMatch = change.before.match(/(\w+)(\??):/);
                const afterMatch = change.after.match(/(\w+)(\??):/);
                
                if (beforeMatch && afterMatch && beforeMatch[1] === afterMatch[1]) {
                    // Same parameter name, show the change
                    const paramName = beforeMatch[1];
                    const beforeType = change.before.replace(`${paramName}${beforeMatch[2]}:`, '').trim();
                    const afterType = change.after.replace(`${paramName}${afterMatch[2]}:`, '').trim();
                    return `${change.symbolName}(${change.before}) → ${change.symbolName}(${change.after})`;
                }
                return `${change.symbolName}(${change.before}) → ${change.symbolName}(${change.after})`;
            }
        }
        return this.formatBreakingChangeDescription(change);
    }

    /**
     * Format impact summary
     */
    private formatImpactSummary(change: any): string {
        const parts: string[] = [];
        
        if (change.impactedFiles && change.impactedFiles.length > 0) {
            parts.push(`${change.impactedFiles.length} downstream file${change.impactedFiles.length !== 1 ? 's' : ''}`);
        }
        
        if (change.impactedTests && change.impactedTests.length > 0) {
            parts.push(`${change.impactedTests.length} affected test${change.impactedTests.length !== 1 ? 's' : ''}`);
        }
        
        if (change.symbolKind === 'function' || change.symbolKind === 'method') {
            parts.push(`1 function affected`);
        }
        
        return parts.length > 0 ? parts.join(', ') : 'No impact detected';
    }

    /**
     * Get recommended actions for a breaking change
     */
    private getRecommendedActions(change: any): string[] {
        const actions: string[] = [];
        
        switch (change.changeKind) {
            case 'signature_required_param_added':
            case 'signature_param_became_required':
                actions.push('Update callers to pass the required parameter');
                actions.push('OR add default value to the parameter');
                actions.push('OR add overload to preserve backward compatibility');
                break;
                
            case 'signature_param_type_narrowed':
                actions.push('Update callers to use the narrowed type');
                actions.push('OR widen the parameter type if possible');
                break;
                
            case 'export_removed':
            case 'component_removed':
                actions.push('Restore the export if it\'s still needed');
                actions.push('OR update all importers to use alternative');
                actions.push('OR mark as deprecated first, then remove in next version');
                break;
                
            case 'class_member_removed_or_privatised':
                actions.push('Restore the member if it\'s still needed');
                actions.push('OR update all usages to use alternative');
                actions.push('OR add a public getter/setter if access is needed');
                break;
                
            case 'type_required_prop_added_or_made_required':
                actions.push('Update all usages to provide the required property');
                actions.push('OR make the property optional if possible');
                break;
                
            case 'type_prop_removed_or_narrowed':
                actions.push('Restore the property if it\'s still needed');
                actions.push('OR update all usages to use alternative');
                break;
                
            case 'component_props_stricter':
                actions.push('Update all component usages to provide required props');
                actions.push('OR make props optional if possible');
                break;
                
            default:
                actions.push('Review the change and update affected code');
                actions.push('Consider maintaining backward compatibility');
        }
        
        return actions;
    }

    /**
     * Build tooltip for breaking changes summary
     */
    private buildBreakingChangesTooltip(breakingChanges: any[], result: ImpactAnalysisResult, riskLevel: string, impactedFiles: number, impactedTests: number, affectedFunctions: number): string {
        const lines: string[] = [];
        lines.push(`${path.basename(result.filePath)}`);
        lines.push(`${breakingChanges.length} breaking change${breakingChanges.length !== 1 ? 's' : ''} detected (${riskLevel} risk)`);
        lines.push('');
        
        const summaryParts: string[] = [];
        if (affectedFunctions > 0) summaryParts.push(`${affectedFunctions} function${affectedFunctions !== 1 ? 's' : ''}`);
        if (impactedTests > 0) summaryParts.push(`${impactedTests} test${impactedTests !== 1 ? 's' : ''}`);
        if (impactedFiles > 0) summaryParts.push(`${impactedFiles} downstream file${impactedFiles !== 1 ? 's' : ''}`);
        
        if (summaryParts.length > 0) {
            lines.push(`Impact: ${summaryParts.join(', ')}`);
            lines.push('');
        }
        
        for (const change of breakingChanges.slice(0, 3)) {
            lines.push(`• ${this.formatBreakingChangeDescription(change)}`);
        }
        
        if (breakingChanges.length > 3) {
            lines.push(`... and ${breakingChanges.length - 3} more`);
        }
        
        return lines.join('\n');
    }

    /**
     * Build tooltip for individual breaking change
     */
    private buildBreakingChangeTooltip(change: any, filePath: string): string {
        const lines: string[] = [];
        lines.push(this.formatBreakingChangeDescription(change));
        
        if (change.before && change.after) {
            lines.push('');
            lines.push(`Before: ${change.before}`);
            lines.push(`After:  ${change.after}`);
        }
        
        if (change.impactedFiles && change.impactedFiles.length > 0) {
            lines.push('');
            lines.push(`Impact: ${change.impactedFiles.length} file${change.impactedFiles.length !== 1 ? 's' : ''}`);
        }
        
        return lines.join('\n');
    }

    /**
     * Build detailed tooltip for breaking change
     */
    private buildBreakingChangeDetailTooltip(change: any): string {
        const lines: string[] = [];
        lines.push('Breaking Change');
        lines.push('──────────────');
        lines.push(this.formatBreakingChangeDescription(change));
        
        if (change.before && change.after) {
            lines.push('');
            lines.push(`Before: ${change.before}`);
            lines.push(`After:  ${change.after}`);
        }
        
        return lines.join('\n');
    }

    /**
     * Get line number from span
     */
    private getLineNumberFromSpan(span: { start: number; end: number }, filePath: string): number {
        try {
            if (!fs.existsSync(filePath)) {
                return 0;
            }
            const content = fs.readFileSync(filePath, 'utf8');
            const lines = content.substring(0, span.start).split('\n');
            return lines.length;
        } catch {
            return 0;
        }
    }
}
