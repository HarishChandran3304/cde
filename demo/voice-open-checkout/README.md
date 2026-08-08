# Voice Workspace Navigation Demo

Launch the CDE development build with this folder as its workspace and connect the CDE sidebar.

Check fuzzy file navigation:

> Open the cart summary.

CDE opens `src/cart/cart-summary.ts`.

Check workspace symbol navigation:

> Where is `calculateFinalPrice` defined?

CDE opens `src/checkout.ts`, selects `calculateFinalPrice`, and remembers it as the active navigation target.

Check contextual native code intelligence:

> Show me every reference.

The native References peek should include checkout execution, cart summaries, order drafts, and promotion previews. The provider returns all references, including imports and the declaration; it is not filtered to call sites.

Then close the peek or navigate to a usage and say:

> Go back to its definition.

CDE returns to the remembered `calculateFinalPrice` definition.

Other prepared checks:

- “Open checkout.ts.”
- “Open the order draft.”
- “Open `createOrderDraft`.”
- “Show references to `previewDiscount`.”
- “Open the payments ledger.” should fail without changing the editor.
