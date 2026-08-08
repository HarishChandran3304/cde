export interface CheckoutRequest {
	readonly subtotalCents: number;
	readonly discountPercent: number;
}

export function calculateFinalPrice(request: CheckoutRequest): number {
	return request.subtotalCents - (request.subtotalCents * request.discountPercent / 100);
}

export function checkout(request: CheckoutRequest): { totalCents: number } {
	return { totalCents: calculateFinalPrice(request) };
}
