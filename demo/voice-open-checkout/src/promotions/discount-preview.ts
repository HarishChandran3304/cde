import { calculateFinalPrice } from '../checkout';

export interface DiscountPreview {
	readonly discountedTotalCents: number;
	readonly savingsCents: number;
}

export function previewDiscount(subtotalCents: number, discountPercent: number): DiscountPreview {
	const discountedTotalCents = calculateFinalPrice({ subtotalCents, discountPercent });
	return {
		discountedTotalCents,
		savingsCents: subtotalCents - discountedTotalCents,
	};
}
