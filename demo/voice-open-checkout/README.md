# Voice Checkout Navigation Demo

Launch the CDE development build with this folder as its workspace and connect the CDE sidebar.

Check direct navigation:

> Open the file with the checkout logic.

CDE opens `src/checkout.ts` and selects `calculateFinalPrice`.

Then check native code intelligence:

> Show me every caller of `calculateFinalPrice`.

The references view should include checkout execution, cart summaries, order drafts, and promotion previews.
