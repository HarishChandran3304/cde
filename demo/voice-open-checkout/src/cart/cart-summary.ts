import { calculateFinalPrice } from '../checkout';

export interface CartSummary {
	readonly discountPercent: number;
	readonly subtotalCents: number;
	readonly totalCents: number;
}

export function buildCartSummary(subtotalCents: number, discountPercent: number): CartSummary {
	const totalCents = calculateFinalPrice({ subtotalCents, discountPercent });
	return { subtotalCents, discountPercent, totalCents };
}
