import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const ARTIFACT_PATH = resolve('assignment3/artifacts/chaos-results.json');

const SCENARIOS = [
    {
        name: 'payment-gateway-outage',
        chaosProfile: 'PAYMENT_OUTAGE',
        spec: 'e2e/payment-qa.e2e-spec.ts',
    },
    {
        name: 'payment-latency',
        chaosProfile: 'PAYMENT_LATENCY',
        spec: 'e2e/order-lifecycle-qa.e2e-spec.ts',
    },
    {
        name: 'settle-blip',
        chaosProfile: 'SETTLE_BLIP',
        spec: 'e2e/midterm-qa-extended.e2e-spec.ts',
    },
];

function runSuite(spec, chaosProfile) {
    return new Promise(resolvePromise => {
        const startedAt = performance.now();
        const child = spawn(
            'npm',
            ['run', 'e2e', '--', '--reporter=verbose', spec],
            {
                cwd: resolve('packages/core'),
                stdio: ['ignore', 'pipe', 'pipe'],
                env: { ...process.env, DB: 'sqljs', QA_CHAOS: chaosProfile ?? '' },
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
                success: code === 0,
                exitCode: code ?? -1,
                durationMs,
                outputTail: `${stdout}\n${stderr}`.split('\n').slice(-25),
            });
        });
    });
}

async function main() {
    const results = [];

    for (const scenario of SCENARIOS) {
        const injected = await runSuite(scenario.spec, scenario.chaosProfile);
        const recoveryStart = performance.now();
        const recovered = await runSuite(scenario.spec, '');
        const mttrMs = Math.round(performance.now() - recoveryStart);

        results.push({
            scenario: scenario.name,
            spec: scenario.spec,
            chaosProfile: scenario.chaosProfile,
            duringInjection: injected,
            afterRecovery: recovered,
            availabilityDuringInjectionPercent: injected.success ? 100 : 0,
            mttrMs,
        });
    }

    const payload = {
        generatedAt: new Date().toISOString(),
        command: 'node scripts/assignment3/run-chaos-experiments.mjs',
        scenarios: results,
    };

    mkdirSync(dirname(ARTIFACT_PATH), { recursive: true });
    writeFileSync(ARTIFACT_PATH, JSON.stringify(payload, null, 2));
    console.log(`Chaos report written to ${ARTIFACT_PATH}`);
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
