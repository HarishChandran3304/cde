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

## Editor choreography

Use placement while opening files and symbols:

- “Keep this open and put the order draft on the right.”
- “Open the cart summary on the left.”
- “Open `calculateFinalPrice` beside this.”
- “Open its definition below.”

Control the native editor layout and history:

- “Split this to the right.” or “Split this below.”
- “Focus the editor on the left.”
- “Move this tab to the right.”
- “Move this whole pane to the left.”
- “Close this tab.”, “Close the other tabs.”, or “Close the other panes.”
- “Pin this tab.”
- “Go back.” or “Go forward.”

## True callers and callees

Open `calculateFinalPrice`, then say:

> Show its actual callers.

CDE opens the native incoming-call hierarchy with `checkout`, `buildCartSummary`, `createOrderDraft`, and `previewDiscount`.

Open `createOrderDraft`, then say:

> Show what this function calls.

CDE opens the outgoing-call hierarchy containing `calculateFinalPrice`.

## Golden navigation sequence

1. “Open checkout.”
2. “Keep it on the left and open the order draft on the right.”
3. “Focus the editor on the left.”
4. “Open `calculateFinalPrice`.”
5. “Show its actual callers.”
6. “Focus the editor on the right.”
7. “Close this pane.”
