import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const ARTIFACT_PATH = resolve('assignment3/artifacts/mutation-results.json');
const TEST_ARGS = [
    'e2e/order-lifecycle-qa.e2e-spec.ts',
    'e2e/payment-qa.e2e-spec.ts',
    'e2e/midterm-qa-extended.e2e-spec.ts',
];

const MUTANTS = [
    { id: 'M1_SUCCESS_TO_DECLINED', type: 'Return value mutation', module: 'payment-processing' },
    { id: 'M2_SUCCESS_TXID_CHANGED', type: 'Constant mutation', module: 'payment-processing' },
    { id: 'M3_TWO_STAGE_BECOMES_SINGLE_STAGE', type: 'State transition mutation', module: 'payment-processing' },
    { id: 'M4_SETTLE_RETURNS_ERROR', type: 'Function result mutation', module: 'payment-processing' },
    { id: 'M5_FAILING_TO_SETTLED', type: 'Logical mutation', module: 'payment-processing' },
    { id: 'M6_ERROR_TO_DECLINED', type: 'Return value mutation', module: 'payment-processing' },
    { id: 'M7_REFUND_SETTLED_TO_FAILED', type: 'Refund state mutation', module: 'payment-processing' },
];

function runSuite(mutantId) {
    return new Promise(resolvePromise => {
        const startedAt = performance.now();
        const child = spawn(
            'npm',
            ['run', 'e2e', '--', '--reporter=verbose', ...TEST_ARGS],
            {
                cwd: resolve('packages/core'),
                stdio: ['ignore', 'pipe', 'pipe'],
                env: { ...process.env, DB: 'sqljs', QA_MUTANT: mutantId ?? '' },
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
            const durationMs = Math.round(performance.now() - startedAt);
            resolvePromise({
                mutantId: mutantId ?? 'BASELINE',
                success: code === 0,
                code: code ?? -1,
                durationMs,
                outputTail: `${stdout}\n${stderr}`.split('\n').slice(-25),
            });
        });
    });
}

async function main() {
    const baseline = await runSuite('');
    const results = [];

    for (const mutant of MUTANTS) {
        const execution = await runSuite(mutant.id);
        results.push({
            ...mutant,
            status: execution.success ? 'Survived' : 'Killed',
            durationMs: execution.durationMs,
            exitCode: execution.code,
            outputTail: execution.outputTail,
        });
    }

    const killed = results.filter(r => r.status === 'Killed').length;
    const score = Number(((killed / results.length) * 100).toFixed(2));

    const payload = {
        generatedAt: new Date().toISOString(),
        command: 'node scripts/assignment3/run-mutation-experiments.mjs',
        baseline: {
            success: baseline.success,
            durationMs: baseline.durationMs,
            exitCode: baseline.code,
        },
        mutants: results,
        summary: {
            totalMutants: results.length,
            killedMutants: killed,
            survivedMutants: results.length - killed,
            mutationScorePercent: score,
        },
    };

    mkdirSync(dirname(ARTIFACT_PATH), { recursive: true });
    writeFileSync(ARTIFACT_PATH, JSON.stringify(payload, null, 2));
    console.log(`Mutation report written to ${ARTIFACT_PATH}`);
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
