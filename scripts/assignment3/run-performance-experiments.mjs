import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const ARTIFACT_PATH = resolve('assignment3/artifacts/performance-results.json');

const MODULE_SPECS = [
    { module: 'order-processing', spec: 'e2e/order-lifecycle-qa.e2e-spec.ts' },
    { module: 'payment-processing', spec: 'e2e/payment-qa.e2e-spec.ts' },
    { module: 'auth-authorization', spec: 'e2e/auth.e2e-spec.ts' },
];

const SCENARIOS = [
    { name: 'normal-load', concurrency: 2, rounds: 2 },
    { name: 'peak-load', concurrency: 4, rounds: 2 },
    { name: 'spike-load', concurrency: 6, rounds: 1 },
    { name: 'endurance-load', concurrency: 2, rounds: 4 },
];

function runSpec(spec) {
    return new Promise(resolvePromise => {
        const startedAt = performance.now();
        const child = spawn(
            'npm',
            ['run', 'e2e', '--', '--reporter=verbose', spec],
            {
                cwd: resolve('packages/core'),
                stdio: ['ignore', 'pipe', 'pipe'],
                env: { ...process.env, DB: 'sqljs' },
            },
        );

        let stdout = '';
        let stderr = '';
        child.stdout.on('data', chunk => {
            stdout += chunk.toString();
        });
        child.stderr.on('data', chunk => {
            stderr += chunk.toString();
        });

        child.on('close', code => {
            const endedAt = performance.now();
            resolvePromise({
                spec,
                durationMs: Math.round(endedAt - startedAt),
                success: code === 0,
                code: code ?? -1,
                output: `${stdout}\n${stderr}`,
            });
        });
    });
}

function percentile(values, p) {
    if (values.length === 0) {
        return 0;
    }
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
    return sorted[index];
}

async function main() {
    const scenarioResults = [];

    for (const scenario of SCENARIOS) {
        const wallStart = performance.now();
        const runs = [];
        let moduleIndex = 0;

        for (let round = 0; round < scenario.rounds; round++) {
            const batch = [];
            for (let slot = 0; slot < scenario.concurrency; slot++) {
                const moduleTarget = MODULE_SPECS[moduleIndex % MODULE_SPECS.length];
                moduleIndex++;
                batch.push(
                    runSpec(moduleTarget.spec).then(result => ({
                        ...result,
                        module: moduleTarget.module,
                    })),
                );
            }
            const batchResults = await Promise.all(batch);
            runs.push(...batchResults);
        }

        const wallDurationMs = Math.round(performance.now() - wallStart);
        const latencies = runs.map(r => r.durationMs);
        const failed = runs.filter(r => !r.success).length;
        const throughputPerMinute = Number(((runs.length / wallDurationMs) * 60000).toFixed(2));

        scenarioResults.push({
            scenario: scenario.name,
            concurrency: scenario.concurrency,
            rounds: scenario.rounds,
            totalRuns: runs.length,
            failedRuns: failed,
            errorRatePercent: Number(((failed / runs.length) * 100).toFixed(2)),
            avgResponseMs: Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length),
            medianResponseMs: percentile(latencies, 50),
            p95ResponseMs: percentile(latencies, 95),
            throughputRunsPerMinute: throughputPerMinute,
            wallDurationMs,
            runDetails: runs.map(r => ({
                module: r.module,
                spec: r.spec,
                durationMs: r.durationMs,
                success: r.success,
                code: r.code,
            })),
        });
    }

    const payload = {
        generatedAt: new Date().toISOString(),
        command: 'node scripts/assignment3/run-performance-experiments.mjs',
        scenarios: scenarioResults,
    };

    mkdirSync(dirname(ARTIFACT_PATH), { recursive: true });
    writeFileSync(ARTIFACT_PATH, JSON.stringify(payload, null, 2));
    console.log(`Performance report written to ${ARTIFACT_PATH}`);
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
