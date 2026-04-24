import { Payment, PaymentMethodHandler, TransactionalConnection } from '@vendure/core';
import { vi } from 'vitest';

import { LanguageCode } from '../graphql/generated-e2e-admin-types';

const activeMutant = process.env.QA_MUTANT ?? '';
const activeChaos = process.env.QA_CHAOS ?? '';

const isMutant = (mutantId: string) => activeMutant === mutantId;
const isChaosProfile = (profileId: string) => activeChaos === profileId;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

let chaosPaymentOutageAttempts = 0;
let chaosSettleBlipAttempts = 0;

export const testSuccessfulPaymentMethod = new PaymentMethodHandler({
    code: 'test-payment-method',
    description: [{ languageCode: LanguageCode.en, value: 'Test Payment Method' }],
    args: {},
    createPayment: async (ctx, order, amount, args, metadata) => {
        if (isChaosProfile('PAYMENT_LATENCY')) {
            await sleep(500);
        }
        if (isChaosProfile('PAYMENT_OUTAGE')) {
            chaosPaymentOutageAttempts++;
            if (chaosPaymentOutageAttempts <= 2) {
                return {
                    amount,
                    state: 'Error',
                    errorMessage: 'Simulated gateway outage',
                    metadata: { public: metadata },
                };
            }
        }
        if (isMutant('M1_SUCCESS_TO_DECLINED')) {
            return {
                amount,
                state: 'Declined',
                errorMessage: 'Mutant converted success to decline',
                metadata: { public: metadata },
            };
        }
        return {
            amount,
            state: 'Settled',
            transactionId: isMutant('M2_SUCCESS_TXID_CHANGED') ? 'mutant-tx' : '12345',
            metadata: { public: metadata },
        };
    },
    settlePayment: () => ({
        success: true,
    }),
});

export const onTransitionSpy = vi.fn();
export const onCancelPaymentSpy = vi.fn();
/**
 * A two-stage (authorize, capture) payment method, with no createRefund method.
 */
export const twoStagePaymentMethod = new PaymentMethodHandler({
    code: 'authorize-only-payment-method',
    description: [{ languageCode: LanguageCode.en, value: 'Test Payment Method' }],
    args: {},
    createPayment: (ctx, order, amount, args, metadata) => {
        if (isMutant('M3_TWO_STAGE_BECOMES_SINGLE_STAGE')) {
            return {
                amount,
                state: 'Settled',
                transactionId: '12345-' + order.code,
                metadata: { public: metadata },
            };
        }
        return {
            amount,
            state: 'Authorized',
            transactionId: '12345-' + order.code,
            metadata: { public: metadata },
        };
    },
    settlePayment: async () => {
        if (isChaosProfile('SETTLE_BLIP')) {
            chaosSettleBlipAttempts++;
            if (chaosSettleBlipAttempts === 1) {
                return {
                    success: false,
                    state: 'Error',
                    errorMessage: 'Simulated settle timeout',
                };
            }
        }
        if (isMutant('M4_SETTLE_RETURNS_ERROR')) {
            return {
                success: false,
                state: 'Error',
                errorMessage: 'Mutant forced settle error',
            };
        }
        return {
            success: true,
            metadata: {
                moreData: 42,
            },
        };
    },
    cancelPayment: (...args) => {
        onCancelPaymentSpy(...args);
        return {
            success: true,
            metadata: {
                cancellationCode: '12345',
            },
        };
    },
    onStateTransitionStart: (fromState, toState, data) => {
        onTransitionSpy(fromState, toState, data);
    },
});

/**
 * A method that can be used to pay for only part of the order (allowing us to test multiple payments
 * per order).
 */
export const partialPaymentMethod = new PaymentMethodHandler({
    code: 'partial-payment-method',
    description: [{ languageCode: LanguageCode.en, value: 'Partial Payment Method' }],
    args: {},
    createPayment: (ctx, order, amount, args, metadata) => {
        return {
            amount: metadata.amount,
            state: metadata.authorizeOnly ? 'Authorized' : 'Settled',
            transactionId: '12345',
            metadata: { public: metadata },
        };
    },
    settlePayment: () => {
        return {
            success: true,
        };
    },
});

/**
 * A payment method which includes a createRefund method.
 */
export const singleStageRefundablePaymentMethod = new PaymentMethodHandler({
    code: 'single-stage-refundable-payment-method',
    description: [{ languageCode: LanguageCode.en, value: 'Test Payment Method' }],
    args: {},
    createPayment: (ctx, order, amount, args, metadata) => {
        return {
            amount,
            state: 'Settled',
            transactionId: '12345',
            metadata,
        };
    },
    settlePayment: () => {
        return { success: true };
    },
    createRefund: (ctx, input, amount, order, payment, args) => {
        if (isMutant('M7_REFUND_SETTLED_TO_FAILED')) {
            return {
                state: 'Failed',
                transactionId: 'mutant-refund-failed',
                metadata: { amount },
            };
        }
        return {
            state: 'Settled',
            transactionId: 'abc123',
            metadata: { amount },
        };
    },
});

let connection: TransactionalConnection;
/**
 * A payment method where a Refund attempt will fail the first time
 */
export const singleStageRefundFailingPaymentMethod = new PaymentMethodHandler({
    code: 'single-stage-refund-failing-payment-method',
    description: [{ languageCode: LanguageCode.en, value: 'Test Payment Method' }],
    args: {},
    init: injector => {
        connection = injector.get(TransactionalConnection);
    },
    createPayment: (ctx, order, amount, args, metadata) => {
        return {
            amount,
            state: 'Settled',
            transactionId: '12345',
            metadata,
        };
    },
    settlePayment: () => {
        return { success: true };
    },
    createRefund: async (ctx, input, amount, order, payment, args) => {
        const paymentWithRefunds = await connection
            .getRepository(ctx, Payment)
            .findOne({ where: { id: payment.id }, relations: ['refunds'] });
        const isFirstRefundAttempt = paymentWithRefunds?.refunds.length === 0;
        const metadata = isFirstRefundAttempt ? { errorMessage: 'Service temporarily unavailable' } : {};
        return {
            state: isFirstRefundAttempt ? 'Failed' : 'Settled',
            metadata,
        };
    },
});

/**
 * A payment method where calling `settlePayment` always fails.
 */
export const failsToSettlePaymentMethod = new PaymentMethodHandler({
    code: 'fails-to-settle-payment-method',
    description: [{ languageCode: LanguageCode.en, value: 'Test Payment Method' }],
    args: {},
    createPayment: (ctx, order, amount, args, metadata) => {
        return {
            amount,
            state: 'Authorized',
            transactionId: '12345-' + order.code,
            metadata: {
                privateCreatePaymentData: 'secret',
                public: {
                    publicCreatePaymentData: 'public',
                },
            },
        };
    },
    settlePayment: () => {
        return {
            success: false,
            state: 'Cancelled',
            errorMessage: 'Something went horribly wrong',
            metadata: {
                privateSettlePaymentData: 'secret',
                public: {
                    publicSettlePaymentData: 'public',
                },
            },
        };
    },
});

/**
 * A payment method where calling `settlePayment` always fails.
 */
export const failsToCancelPaymentMethod = new PaymentMethodHandler({
    code: 'fails-to-cancel-payment-method',
    description: [{ languageCode: LanguageCode.en, value: 'Test Payment Method' }],
    args: {},
    createPayment: (ctx, order, amount, args, metadata) => {
        return {
            amount,
            state: 'Authorized',
            transactionId: '12345-' + order.code,
        };
    },
    settlePayment: () => {
        return {
            success: true,
        };
    },
    cancelPayment: (ctx, order, payment) => {
        return {
            success: false,
            errorMessage: 'something went horribly wrong',
            state: payment.state !== 'Cancelled' ? payment.state : undefined,
            metadata: {
                cancellationData: 'foo',
            },
        };
    },
});

export const testFailingPaymentMethod = new PaymentMethodHandler({
    code: 'test-failing-payment-method',
    description: [{ languageCode: LanguageCode.en, value: 'Test Failing Payment Method' }],
    args: {},
    createPayment: (ctx, order, amount, args, metadata) => {
        if (isMutant('M5_FAILING_TO_SETTLED')) {
            return {
                amount,
                state: 'Settled',
                transactionId: 'mutant-recovered',
                metadata: { public: metadata },
            };
        }
        return {
            amount,
            state: 'Declined',
            errorMessage: 'Insufficient funds',
            metadata: { public: metadata },
        };
    },
    settlePayment: () => ({
        success: true,
    }),
});
export const testErrorPaymentMethod = new PaymentMethodHandler({
    code: 'test-error-payment-method',
    description: [{ languageCode: LanguageCode.en, value: 'Test Error Payment Method' }],
    args: {},
    createPayment: (ctx, order, amount, args, metadata) => {
        if (isMutant('M6_ERROR_TO_DECLINED')) {
            return {
                amount,
                state: 'Declined',
                errorMessage: 'Mutant changed error to decline',
                metadata,
            };
        }
        return {
            amount,
            state: 'Error',
            errorMessage: 'Something went horribly wrong',
            metadata,
        };
    },
    settlePayment: () => ({
        success: true,
    }),
});
