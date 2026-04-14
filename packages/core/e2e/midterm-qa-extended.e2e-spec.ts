/**
 * Midterm QA Extended Test Suite
 *
 * Implements 8 NEW test cases required by the Midterm Project (Week 5).
 * Each test targets a previously identified high-risk module and falls
 * into one of the mandatory categories:
 *
 *   1. Failure Scenarios      — MT-FAIL-01, MT-FAIL-02
 *   2. Edge Cases             — MT-EDGE-01, MT-EDGE-02
 *   3. Concurrency            — MT-CONC-01, MT-CONC-02
 *   4. Invalid User Behavior  — MT-INV-01, MT-INV-02
 *
 * Framework: Vitest + @vendure/testing
 * Target Modules: Order Processing (Critical), Payment Processing (Critical)
 */

/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { manualFulfillmentHandler, mergeConfig } from '@vendure/core';
import { createErrorResultGuard, createTestEnvironment, ErrorResultGuard } from '@vendure/testing';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { initialData } from '../../../e2e-common/e2e-initial-data';
import { TEST_SETUP_TIMEOUT_MS, testConfig } from '../../../e2e-common/test-config';

import {
    singleStageRefundablePaymentMethod,
    testErrorPaymentMethod,
    testFailingPaymentMethod,
    testSuccessfulPaymentMethod,
    twoStagePaymentMethod,
} from './fixtures/test-payment-methods';
import * as Codegen from './graphql/generated-e2e-admin-types';
import * as CodegenShop from './graphql/generated-e2e-shop-types';
import { TestOrderFragmentFragment } from './graphql/generated-e2e-shop-types';
import {
    CREATE_FULFILLMENT,
    GET_CUSTOMER_LIST,
    GET_ORDER,
    SETTLE_PAYMENT,
} from './graphql/shared-definitions';
import {
    ADD_ITEM_TO_ORDER,
    ADD_PAYMENT,
    ADJUST_ITEM_QUANTITY,
    GET_ACTIVE_ORDER,
    TRANSITION_TO_STATE,
} from './graphql/shop-definitions';
import { addPaymentToOrder, proceedToArrangingPayment } from './utils/test-order-utils';

describe('Midterm QA Extended Test Suite', () => {
    const { server, adminClient, shopClient } = createTestEnvironment(
        mergeConfig(testConfig(), {
            paymentOptions: {
                paymentMethodHandlers: [
                    testSuccessfulPaymentMethod,
                    twoStagePaymentMethod,
                    testFailingPaymentMethod,
                    testErrorPaymentMethod,
                    singleStageRefundablePaymentMethod,
                ],
            },
        }),
    );

    let customers: Codegen.GetCustomerListQuery['customers']['items'];
    const password = 'test';

    const orderGuard: ErrorResultGuard<TestOrderFragmentFragment> = createErrorResultGuard(
        input => !!input.lines,
    );

    const fulfillmentGuard: ErrorResultGuard<Codegen.FulfillmentFragment> = createErrorResultGuard(
        input => !!input.method,
    );

    const paymentGuard: ErrorResultGuard<Codegen.PaymentFragment> = createErrorResultGuard(
        input => !!input.state,
    );

    beforeAll(async () => {
        await server.init({
            initialData: {
                ...initialData,
                paymentMethods: [
                    {
                        name: testSuccessfulPaymentMethod.code,
                        handler: { code: testSuccessfulPaymentMethod.code, arguments: [] },
                    },
                    {
                        name: twoStagePaymentMethod.code,
                        handler: { code: twoStagePaymentMethod.code, arguments: [] },
                    },
                    {
                        name: testFailingPaymentMethod.code,
                        handler: { code: testFailingPaymentMethod.code, arguments: [] },
                    },
                    {
                        name: testErrorPaymentMethod.code,
                        handler: { code: testErrorPaymentMethod.code, arguments: [] },
                    },
                    {
                        name: singleStageRefundablePaymentMethod.code,
                        handler: { code: singleStageRefundablePaymentMethod.code, arguments: [] },
                    },
                ],
            },
            productsCsvPath: path.join(__dirname, 'fixtures/e2e-products-full.csv'),
            customerCount: 5,
        });
        await adminClient.asSuperAdmin();

        const result = await adminClient.query<
            Codegen.GetCustomerListQuery,
            Codegen.GetCustomerListQueryVariables
        >(GET_CUSTOMER_LIST, { options: { take: 5 } });
        customers = result.customers.items;
    }, TEST_SETUP_TIMEOUT_MS);

    afterAll(async () => {
        await server.destroy();
    });

    // =========================================================================
    // CATEGORY 1: Failure Scenarios
    // =========================================================================

    describe('MT-FAIL-01: Consecutive payment failures do not corrupt order state', () => {
        it('order remains in ArrangingPayment after multiple declined attempts', async () => {
            await shopClient.asUserWithCredentials(customers[0].emailAddress, password);

            await shopClient.query<
                CodegenShop.AddItemToOrderMutation,
                CodegenShop.AddItemToOrderMutationVariables
            >(ADD_ITEM_TO_ORDER, {
                productVariantId: 'T_1',
                quantity: 1,
            });

            await proceedToArrangingPayment(shopClient);

            // First declined attempt
            const { addPaymentToOrder: result1 } = await shopClient.query<
                CodegenShop.AddPaymentToOrderMutation,
                CodegenShop.AddPaymentToOrderMutationVariables
            >(ADD_PAYMENT, {
                input: { method: testFailingPaymentMethod.code, metadata: {} },
            });
            expect(
                (result1 as any).errorCode ||
                    (result1 as any).paymentErrorMessage ||
                    (result1 as any).state === 'ArrangingPayment',
            ).toBeTruthy();

            // Second declined attempt
            const { addPaymentToOrder: result2 } = await shopClient.query<
                CodegenShop.AddPaymentToOrderMutation,
                CodegenShop.AddPaymentToOrderMutationVariables
            >(ADD_PAYMENT, {
                input: { method: testFailingPaymentMethod.code, metadata: {} },
            });
            expect(
                (result2 as any).errorCode ||
                    (result2 as any).paymentErrorMessage ||
                    (result2 as any).state === 'ArrangingPayment',
            ).toBeTruthy();

            // Third declined attempt
            const { addPaymentToOrder: result3 } = await shopClient.query<
                CodegenShop.AddPaymentToOrderMutation,
                CodegenShop.AddPaymentToOrderMutationVariables
            >(ADD_PAYMENT, {
                input: { method: testFailingPaymentMethod.code, metadata: {} },
            });
            expect(
                (result3 as any).errorCode ||
                    (result3 as any).paymentErrorMessage ||
                    (result3 as any).state === 'ArrangingPayment',
            ).toBeTruthy();

            // Recovery: successful payment after three failures
            const order = await addPaymentToOrder(shopClient, testSuccessfulPaymentMethod);
            orderGuard.assertSuccess(order);
            expect(order.state).toBe('PaymentSettled');

            // Should have all four payment attempts recorded
            expect(order.payments!.length).toBe(4);
            const declined = order.payments!.filter(p => p.state === 'Declined');
            const settled = order.payments!.filter(p => p.state === 'Settled');
            expect(declined.length).toBe(3);
            expect(settled.length).toBe(1);
        });
    });

    describe('MT-FAIL-02: Fulfillment with over-quantity is rejected', () => {
        let orderId: string;

        beforeAll(async () => {
            await shopClient.asUserWithCredentials(customers[1].emailAddress, password);

            await shopClient.query<
                CodegenShop.AddItemToOrderMutation,
                CodegenShop.AddItemToOrderMutationVariables
            >(ADD_ITEM_TO_ORDER, {
                productVariantId: 'T_2',
                quantity: 1,
            });

            orderId = (await proceedToArrangingPayment(shopClient)) as string;
            await addPaymentToOrder(shopClient, testSuccessfulPaymentMethod);
        });

        it('rejects fulfillment when requested quantity exceeds ordered quantity', async () => {
            const { order } = await adminClient.query<Codegen.GetOrderQuery, Codegen.GetOrderQueryVariables>(
                GET_ORDER,
                { id: orderId },
            );

            const { addFulfillmentToOrder } = await adminClient.query<
                Codegen.CreateFulfillmentMutation,
                Codegen.CreateFulfillmentMutationVariables
            >(CREATE_FULFILLMENT, {
                input: {
                    lines: order!.lines.map(l => ({
                        orderLineId: l.id,
                        quantity: l.quantity + 100,
                    })),
                    handler: {
                        code: manualFulfillmentHandler.code,
                        arguments: [
                            { name: 'method', value: 'Test' },
                            { name: 'trackingCode', value: 'OVER-QTY' },
                        ],
                    },
                },
            });
            fulfillmentGuard.assertErrorResult(addFulfillmentToOrder);
        });
    });

    // =========================================================================
    // CATEGORY 2: Edge Cases
    // =========================================================================

    describe('MT-EDGE-01: Adding item with quantity zero', () => {
        it('rejects adding an item with quantity zero to the order', async () => {
            await shopClient.asUserWithCredentials(customers[2].emailAddress, password);

            const { addItemToOrder } = await shopClient.query<
                CodegenShop.AddItemToOrderMutation,
                CodegenShop.AddItemToOrderMutationVariables
            >(ADD_ITEM_TO_ORDER, {
                productVariantId: 'T_1',
                quantity: 0,
            });

            // Vendure should reject quantity of 0
            expect((addItemToOrder as any).errorCode || (addItemToOrder as any).message).toBeTruthy();
        });
    });

    describe('MT-EDGE-02: Adjusting order line quantity to a very large number', () => {
        it('handles an extremely large quantity adjustment gracefully', async () => {
            await shopClient.asUserWithCredentials(customers[2].emailAddress, password);

            // Add a valid item first
            const { addItemToOrder } = await shopClient.query<
                CodegenShop.AddItemToOrderMutation,
                CodegenShop.AddItemToOrderMutationVariables
            >(ADD_ITEM_TO_ORDER, {
                productVariantId: 'T_3',
                quantity: 1,
            });
            orderGuard.assertSuccess(addItemToOrder);
            const lineId = addItemToOrder.lines[0].id;

            // Try to adjust to an absurdly large amount (should hit stock limits)
            const { adjustOrderLine } = await shopClient.query<
                CodegenShop.AdjustItemQuantityMutation,
                CodegenShop.AdjustItemQuantityMutationVariables
            >(ADJUST_ITEM_QUANTITY, {
                orderLineId: lineId,
                quantity: 999999,
            });

            // Should either succeed with stock-limited quantity or return InsufficientStockError
            const isError = !!(adjustOrderLine as any).errorCode;
            const isSuccess = !!(adjustOrderLine as any).lines;
            expect(isError || isSuccess).toBe(true);

            if (isSuccess) {
                // If it succeeded, the order should have a valid total
                expect((adjustOrderLine as any).totalWithTax).toBeGreaterThan(0);
            }
        });
    });

    // =========================================================================
    // CATEGORY 3: Concurrency / Race Conditions
    // =========================================================================

    describe('MT-CONC-01: Concurrent add-to-cart operations', () => {
        it('handles multiple simultaneous addItemToOrder calls correctly', async () => {
            await shopClient.asUserWithCredentials(customers[3].emailAddress, password);

            // Fire 5 add-to-cart requests concurrently for different variants
            const variants = ['T_1', 'T_2', 'T_3', 'T_4', 'T_5'];
            const promises = variants.map(vid =>
                shopClient.query<
                    CodegenShop.AddItemToOrderMutation,
                    CodegenShop.AddItemToOrderMutationVariables
                >(ADD_ITEM_TO_ORDER, {
                    productVariantId: vid,
                    quantity: 1,
                }),
            );

            const results = await Promise.allSettled(promises);

            // All requests should resolve (not throw)
            for (const result of results) {
                expect(result.status).toBe('fulfilled');
            }

            // Retrieve the final order state
            const { activeOrder } = await shopClient.query<CodegenShop.GetActiveOrderQuery>(GET_ACTIVE_ORDER);

            // The order should exist and have a consistent state
            expect(activeOrder).toBeDefined();
            expect(activeOrder!.state).toBe('AddingItems');
            // Total must be positive (items were added)
            expect(activeOrder!.totalWithTax).toBeGreaterThan(0);
        });
    });

    describe('MT-CONC-02: Concurrent payment settlement attempts on same order', () => {
        it('handles double-settle attempts without duplicating settlement', async () => {
            await shopClient.asUserWithCredentials(customers[4].emailAddress, password);

            await shopClient.query<
                CodegenShop.AddItemToOrderMutation,
                CodegenShop.AddItemToOrderMutationVariables
            >(ADD_ITEM_TO_ORDER, {
                productVariantId: 'T_1',
                quantity: 1,
            });

            await proceedToArrangingPayment(shopClient);

            // Create an authorized payment (two-stage)
            const order = await addPaymentToOrder(shopClient, twoStagePaymentMethod);
            orderGuard.assertSuccess(order);
            expect(order.state).toBe('PaymentAuthorized');

            const paymentId = order.payments![0].id;

            // Attempt to settle the same payment concurrently from admin
            const settlePromise1 = adminClient.query<
                Codegen.SettlePaymentMutation,
                Codegen.SettlePaymentMutationVariables
            >(SETTLE_PAYMENT, { id: paymentId });

            const settlePromise2 = adminClient.query<
                Codegen.SettlePaymentMutation,
                Codegen.SettlePaymentMutationVariables
            >(SETTLE_PAYMENT, { id: paymentId });

            const [result1, result2] = await Promise.allSettled([settlePromise1, settlePromise2]);

            // At least one should succeed, the other should either succeed (idempotent)
            // or return an error (payment already settled)
            expect(result1.status).toBe('fulfilled');
            expect(result2.status).toBe('fulfilled');

            // Verify the order ends up in PaymentSettled (not double-settled)
            const { order: finalOrder } = await adminClient.query<
                Codegen.GetOrderQuery,
                Codegen.GetOrderQueryVariables
            >(GET_ORDER, { id: order.id });
            expect(finalOrder!.state).toBe('PaymentSettled');
            // Only one payment should exist
            expect(finalOrder!.payments!.length).toBe(1);
            expect(finalOrder!.payments![0].state).toBe('Settled');
        });
    });

    // =========================================================================
    // CATEGORY 4: Invalid User Behavior
    // =========================================================================

    describe('MT-INV-01: Skipping required steps in order flow', () => {
        it('prevents direct transition from AddingItems to PaymentSettled', async () => {
            await shopClient.asUserWithCredentials(customers[0].emailAddress, password);

            await shopClient.query<
                CodegenShop.AddItemToOrderMutation,
                CodegenShop.AddItemToOrderMutationVariables
            >(ADD_ITEM_TO_ORDER, {
                productVariantId: 'T_5',
                quantity: 1,
            });

            // Try to jump directly to a state that requires intermediate steps
            const { transitionOrderToState } = await shopClient.query<
                CodegenShop.TransitionToStateMutation,
                CodegenShop.TransitionToStateMutationVariables
            >(TRANSITION_TO_STATE, { state: 'PaymentSettled' });

            // This should fail because PaymentSettled is not a valid next state from AddingItems
            expect(
                (transitionOrderToState as any).errorCode ||
                    (transitionOrderToState as any).transitionError ||
                    (transitionOrderToState as any).message,
            ).toBeTruthy();
        });
    });

    describe('MT-INV-02: Adding payment to order in wrong state', () => {
        it('prevents adding payment when order is in AddingItems state', async () => {
            await shopClient.asUserWithCredentials(customers[3].emailAddress, password);

            // Customer[3] has an active order from CONC-01 in AddingItems state
            // Try to add payment directly without transitioning to ArrangingPayment
            const { addPaymentToOrder: result } = await shopClient.query<
                CodegenShop.AddPaymentToOrderMutation,
                CodegenShop.AddPaymentToOrderMutationVariables
            >(ADD_PAYMENT, {
                input: {
                    method: testSuccessfulPaymentMethod.code,
                    metadata: {},
                },
            });

            // Should receive an error because order is not in ArrangingPayment state
            expect(
                (result as any).errorCode || (result as any).message || (result as any).transitionError,
            ).toBeTruthy();
        });
    });
});
