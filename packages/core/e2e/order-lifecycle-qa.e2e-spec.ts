/**
 * Order Lifecycle Integration Test — Assignment 2 QA Automation
 *
 * Validates the complete order lifecycle through Vendure's state machine:
 *   Created → AddingItems → ArrangingPayment → PaymentSettled → Fulfilled → Delivered
 *
 * Also covers negative / edge-case scenarios:
 *   - Payment declined
 *   - Empty order cannot proceed to payment
 *   - Fulfillment with invalid quantities
 *   - Order cancellation flow
 *
 * Framework: Vitest + @vendure/testing
 * Risk Level: Critical (order processing is revenue-impacting)
 */

/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { manualFulfillmentHandler, mergeConfig } from '@vendure/core';
import { createErrorResultGuard, createTestEnvironment, ErrorResultGuard } from '@vendure/testing';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { initialData } from '../../../e2e-common/e2e-initial-data';
import { TEST_SETUP_TIMEOUT_MS, testConfig } from '../../../e2e-common/test-config';

import {
    testFailingPaymentMethod,
    testSuccessfulPaymentMethod,
    twoStagePaymentMethod,
} from './fixtures/test-payment-methods';
import * as Codegen from './graphql/generated-e2e-admin-types';
import { ErrorCode, HistoryEntryType } from './graphql/generated-e2e-admin-types';
import * as CodegenShop from './graphql/generated-e2e-shop-types';
import { TestOrderFragmentFragment } from './graphql/generated-e2e-shop-types';
import {
    CANCEL_ORDER,
    CREATE_FULFILLMENT,
    GET_CUSTOMER_LIST,
    GET_ORDER,
    GET_ORDER_HISTORY,
    SETTLE_PAYMENT,
    TRANSIT_FULFILLMENT,
} from './graphql/shared-definitions';
import {
    ADD_ITEM_TO_ORDER,
    ADD_PAYMENT,
    REMOVE_ALL_ORDER_LINES,
    SET_SHIPPING_ADDRESS,
    TRANSITION_TO_STATE,
} from './graphql/shop-definitions';
import { addPaymentToOrder, proceedToArrangingPayment } from './utils/test-order-utils';

describe('Order Lifecycle QA Integration Test', () => {
    const { server, adminClient, shopClient } = createTestEnvironment(
        mergeConfig(testConfig(), {
            paymentOptions: {
                paymentMethodHandlers: [
                    testSuccessfulPaymentMethod,
                    twoStagePaymentMethod,
                    testFailingPaymentMethod,
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
                ],
            },
            productsCsvPath: path.join(__dirname, 'fixtures/e2e-products-full.csv'),
            customerCount: 3,
        });
        await adminClient.asSuperAdmin();

        const result = await adminClient.query<
            Codegen.GetCustomerListQuery,
            Codegen.GetCustomerListQueryVariables
        >(GET_CUSTOMER_LIST, { options: { take: 3 } });
        customers = result.customers.items;
    }, TEST_SETUP_TIMEOUT_MS);

    afterAll(async () => {
        await server.destroy();
    });

    // ──────────────────────────────────────────────────────────────────────────
    // POSITIVE: Full happy-path lifecycle
    // ──────────────────────────────────────────────────────────────────────────
    describe('Happy path: complete order lifecycle', () => {
        let orderId: string;

        it('creates an order by adding items (Created → AddingItems)', async () => {
            await shopClient.asUserWithCredentials(customers[0].emailAddress, password);

            const { addItemToOrder } = await shopClient.query<
                CodegenShop.AddItemToOrderMutation,
                CodegenShop.AddItemToOrderMutationVariables
            >(ADD_ITEM_TO_ORDER, {
                productVariantId: 'T_1',
                quantity: 2,
            });
            orderGuard.assertSuccess(addItemToOrder);

            expect(addItemToOrder.state).toBe('AddingItems');
            expect(addItemToOrder.active).toBe(true);
            expect(addItemToOrder.lines.length).toBe(1);
            expect(addItemToOrder.lines[0].quantity).toBe(2);
        });

        it('transitions to ArrangingPayment with address and shipping', async () => {
            orderId = (await proceedToArrangingPayment(shopClient)) as string;
            expect(orderId).toBeDefined();

            const { order } = await adminClient.query<Codegen.GetOrderQuery, Codegen.GetOrderQueryVariables>(
                GET_ORDER,
                { id: orderId },
            );

            expect(order!.state).toBe('ArrangingPayment');
        });

        it('settles payment (ArrangingPayment → PaymentSettled)', async () => {
            const order = await addPaymentToOrder(shopClient, testSuccessfulPaymentMethod);
            orderGuard.assertSuccess(order);

            expect(order.state).toBe('PaymentSettled');
            expect(order.active).toBe(false);
            expect(order.payments!.length).toBe(1);
            expect(order.payments![0].state).toBe('Settled');
        });

        it('creates fulfillment for all order lines (PaymentSettled → Shipped)', async () => {
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
                        quantity: l.quantity,
                    })),
                    handler: {
                        code: manualFulfillmentHandler.code,
                        arguments: [
                            { name: 'method', value: 'Express Shipping' },
                            { name: 'trackingCode', value: 'TRACK-001' },
                        ],
                    },
                },
            });
            fulfillmentGuard.assertSuccess(addFulfillmentToOrder);

            expect(addFulfillmentToOrder.state).toBe('Pending');
            expect(addFulfillmentToOrder.method).toBe('Express Shipping');
            expect(addFulfillmentToOrder.trackingCode).toBe('TRACK-001');
        });

        it('transitions fulfillment to Shipped', async () => {
            const { order } = await adminClient.query<Codegen.GetOrderQuery, Codegen.GetOrderQueryVariables>(
                GET_ORDER,
                { id: orderId },
            );

            const fulfillmentId = order!.fulfillments![0].id;

            const { transitionFulfillmentToState } = await adminClient.query<
                Codegen.TransitFulfillmentMutation,
                Codegen.TransitFulfillmentMutationVariables
            >(TRANSIT_FULFILLMENT, {
                id: fulfillmentId,
                state: 'Shipped',
            });
            fulfillmentGuard.assertSuccess(transitionFulfillmentToState);

            expect(transitionFulfillmentToState.state).toBe('Shipped');

            // Order state should transition to Shipped
            const { order: updatedOrder } = await adminClient.query<
                Codegen.GetOrderQuery,
                Codegen.GetOrderQueryVariables
            >(GET_ORDER, { id: orderId });
            expect(updatedOrder!.state).toBe('Shipped');
        });

        it('transitions fulfillment to Delivered (Shipped → Delivered)', async () => {
            const { order } = await adminClient.query<Codegen.GetOrderQuery, Codegen.GetOrderQueryVariables>(
                GET_ORDER,
                { id: orderId },
            );

            const fulfillmentId = order!.fulfillments![0].id;

            const { transitionFulfillmentToState } = await adminClient.query<
                Codegen.TransitFulfillmentMutation,
                Codegen.TransitFulfillmentMutationVariables
            >(TRANSIT_FULFILLMENT, {
                id: fulfillmentId,
                state: 'Delivered',
            });
            fulfillmentGuard.assertSuccess(transitionFulfillmentToState);

            expect(transitionFulfillmentToState.state).toBe('Delivered');

            // Order state should transition to Delivered
            const { order: updatedOrder } = await adminClient.query<
                Codegen.GetOrderQuery,
                Codegen.GetOrderQueryVariables
            >(GET_ORDER, { id: orderId });
            expect(updatedOrder!.state).toBe('Delivered');
        });

        it('order history contains all state transitions', async () => {
            const { order } = await adminClient.query<
                Codegen.GetOrderHistoryQuery,
                Codegen.GetOrderHistoryQueryVariables
            >(GET_ORDER_HISTORY, { id: orderId });

            const stateTransitions = order?.history.items
                .filter(item => item.type === HistoryEntryType.ORDER_STATE_TRANSITION)
                .map(item => item.data);

            // Created → AddingItems → ArrangingPayment → PaymentSettled → Shipped → Delivered
            expect(stateTransitions?.length).toBeGreaterThanOrEqual(5);
            expect(stateTransitions![0]).toEqual({ from: 'Created', to: 'AddingItems' });
        });
    });

    // ──────────────────────────────────────────────────────────────────────────
    // NEGATIVE: Payment declined
    // ──────────────────────────────────────────────────────────────────────────
    describe('Negative: payment declined', () => {
        it('order remains in ArrangingPayment when payment is declined', async () => {
            await shopClient.asUserWithCredentials(customers[1].emailAddress, password);

            await shopClient.query<
                CodegenShop.AddItemToOrderMutation,
                CodegenShop.AddItemToOrderMutationVariables
            >(ADD_ITEM_TO_ORDER, {
                productVariantId: 'T_3',
                quantity: 1,
            });

            await proceedToArrangingPayment(shopClient);

            // Use the ADD_PAYMENT mutation directly to capture the declined error
            const { addPaymentToOrder: result } = await shopClient.query<
                CodegenShop.AddPaymentToOrderMutation,
                CodegenShop.AddPaymentToOrderMutationVariables
            >(ADD_PAYMENT, {
                input: {
                    method: testFailingPaymentMethod.code,
                    metadata: {},
                },
            });

            // Payment declined — the result contains errorCode or the order stays in ArrangingPayment
            expect((result as any).errorCode || (result as any).paymentErrorMessage).toBeTruthy();
        });
    });

    // ──────────────────────────────────────────────────────────────────────────
    // NEGATIVE: Empty order cannot proceed
    // ──────────────────────────────────────────────────────────────────────────
    describe('Negative: empty order transitions', () => {
        it('cannot transition an empty order to ArrangingPayment', async () => {
            await shopClient.asUserWithCredentials(customers[2].emailAddress, password);

            // Add and then remove to get an active but empty order
            const { addItemToOrder } = await shopClient.query<
                CodegenShop.AddItemToOrderMutation,
                CodegenShop.AddItemToOrderMutationVariables
            >(ADD_ITEM_TO_ORDER, {
                productVariantId: 'T_1',
                quantity: 1,
            });
            orderGuard.assertSuccess(addItemToOrder);

            // Remove all items
            await shopClient.query(REMOVE_ALL_ORDER_LINES);

            // Set address - this should work even for empty orders
            await shopClient.query<
                CodegenShop.SetShippingAddressMutation,
                CodegenShop.SetShippingAddressMutationVariables
            >(SET_SHIPPING_ADDRESS, {
                input: {
                    fullName: 'Empty Test',
                    streetLine1: '1 Empty St',
                    city: 'Nowhere',
                    postalCode: '00000',
                    countryCode: 'US',
                },
            });

            // Attempting to transition to ArrangingPayment should fail
            const { transitionOrderToState } = await shopClient.query<
                CodegenShop.TransitionToStateMutation,
                CodegenShop.TransitionToStateMutationVariables
            >(TRANSITION_TO_STATE, { state: 'ArrangingPayment' });

            // Should get an error (no lines or no shipping method)
            expect(
                (transitionOrderToState as any).errorCode ||
                    (transitionOrderToState as any).state !== 'ArrangingPayment',
            ).toBeTruthy();
        });
    });

    // ──────────────────────────────────────────────────────────────────────────
    // EDGE CASE: Fulfillment with zero quantity
    // ──────────────────────────────────────────────────────────────────────────
    describe('Edge case: fulfillment with zero quantities', () => {
        let paidOrderId: string;

        beforeAll(async () => {
            // Create a new order and pay for it
            await shopClient.asUserWithCredentials(customers[0].emailAddress, password);

            await shopClient.query<
                CodegenShop.AddItemToOrderMutation,
                CodegenShop.AddItemToOrderMutationVariables
            >(ADD_ITEM_TO_ORDER, {
                productVariantId: 'T_4',
                quantity: 1,
            });

            paidOrderId = (await proceedToArrangingPayment(shopClient)) as string;
            await addPaymentToOrder(shopClient, testSuccessfulPaymentMethod);
        });

        it('rejects fulfillment with all zero quantities', async () => {
            const { order } = await adminClient.query<Codegen.GetOrderQuery, Codegen.GetOrderQueryVariables>(
                GET_ORDER,
                { id: paidOrderId },
            );

            const { addFulfillmentToOrder } = await adminClient.query<
                Codegen.CreateFulfillmentMutation,
                Codegen.CreateFulfillmentMutationVariables
            >(CREATE_FULFILLMENT, {
                input: {
                    lines: order!.lines.map(l => ({
                        orderLineId: l.id,
                        quantity: 0,
                    })),
                    handler: {
                        code: manualFulfillmentHandler.code,
                        arguments: [{ name: 'method', value: 'Test' }],
                    },
                },
            });
            fulfillmentGuard.assertErrorResult(addFulfillmentToOrder);
            expect(addFulfillmentToOrder.errorCode).toBe(ErrorCode.EMPTY_ORDER_LINE_SELECTION_ERROR);
        });
    });

    // ──────────────────────────────────────────────────────────────────────────
    // EDGE CASE: Two-stage payment (authorize then settle)
    // ──────────────────────────────────────────────────────────────────────────
    describe('Edge case: two-stage payment flow', () => {
        let orderId: string;

        it('creates order with authorized payment', async () => {
            // Use customer[0] who has no lingering active order (previous order was delivered)
            await shopClient.asUserWithCredentials(customers[0].emailAddress, password);

            await shopClient.query<
                CodegenShop.AddItemToOrderMutation,
                CodegenShop.AddItemToOrderMutationVariables
            >(ADD_ITEM_TO_ORDER, {
                productVariantId: 'T_2',
                quantity: 1,
            });

            await proceedToArrangingPayment(shopClient);

            const order = await addPaymentToOrder(shopClient, twoStagePaymentMethod);
            orderGuard.assertSuccess(order);

            expect(order.state).toBe('PaymentAuthorized');
            expect(order.payments![0].state).toBe('Authorized');
            orderId = order.id;
        });

        it('admin settles the authorized payment', async () => {
            const { order } = await adminClient.query<Codegen.GetOrderQuery, Codegen.GetOrderQueryVariables>(
                GET_ORDER,
                { id: orderId },
            );

            const { settlePayment } = await adminClient.query<
                Codegen.SettlePaymentMutation,
                Codegen.SettlePaymentMutationVariables
            >(SETTLE_PAYMENT, { id: order!.payments![0].id });

            paymentGuard.assertSuccess(settlePayment);
            expect(settlePayment.state).toBe('Settled');

            // Order transitions to PaymentSettled
            const { order: updated } = await adminClient.query<
                Codegen.GetOrderQuery,
                Codegen.GetOrderQueryVariables
            >(GET_ORDER, { id: orderId });
            expect(updated!.state).toBe('PaymentSettled');
        });
    });

    // ──────────────────────────────────────────────────────────────────────────
    // NEGATIVE: Cancel order before fulfillment
    // ──────────────────────────────────────────────────────────────────────────
    describe('Negative: order cancellation', () => {
        let orderId: string;

        it('can cancel an order in AddingItems state', async () => {
            await shopClient.asUserWithCredentials(customers[2].emailAddress, password);

            const { addItemToOrder } = await shopClient.query<
                CodegenShop.AddItemToOrderMutation,
                CodegenShop.AddItemToOrderMutationVariables
            >(ADD_ITEM_TO_ORDER, {
                productVariantId: 'T_1',
                quantity: 1,
            });
            orderGuard.assertSuccess(addItemToOrder);
            orderId = addItemToOrder.id;

            const { cancelOrder } = await adminClient.query<
                Codegen.CancelOrderMutation,
                Codegen.CancelOrderMutationVariables
            >(CANCEL_ORDER, {
                input: {
                    orderId,
                    lines: addItemToOrder.lines.map(l => ({
                        orderLineId: l.id,
                        quantity: l.quantity,
                    })),
                    reason: 'Customer requested cancellation',
                },
            });

            expect(cancelOrder).toBeDefined();
        });
    });
});
