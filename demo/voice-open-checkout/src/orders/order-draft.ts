import { calculateFinalPrice, CheckoutRequest } from '../checkout';

export interface OrderDraft {
	readonly merchandiseTotalCents: number;
	readonly shippingCents: number;
	readonly totalCents: number;
}

export function createOrderDraft(request: CheckoutRequest, shippingCents: number): OrderDraft {
	const merchandiseTotalCents = calculateFinalPrice(request);
	return {
		merchandiseTotalCents,
		shippingCents,
		totalCents: merchandiseTotalCents + shippingCents,
	};
}
