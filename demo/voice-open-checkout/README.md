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

Navigate inside the open References peek:

- “Show the next reference.”
- “Go to the previous reference.”
- “Show me the one in the order draft.”
- “Show me the reference in checkout.js.” CDE fuzzily resolves this to `src/checkout.ts`.
- “Open this reference.”
- “Close references.”

File-specific requests retain the native References UI and advance it to a result in the requested file.

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

## Grounded code Q&A

Open `calculateFinalPrice`, place the cursor on its return statement, then ask:

> Why can the discount make this negative?

Claude inspects the repository through read-only search tools. CDE speaks a short answer while the sidebar shows the grounded explanation with `src/checkout.ts:line` citations.

Continue with contextual and repository-wide questions:

- “What does this function do?”
- “Where does `discountPercent` come from?”
- “Which user-visible flows depend on this calculation?”
- “Walk me through the data flow from the cart summary to the final total.”
- “What is risky about changing this function?”
- “How would you fix this at the API boundary?”

The Q&A worker can read, glob, and grep the open workspace. It cannot edit files, run shell commands, browse the web, or use external MCP tools.

## Golden navigation sequence

1. “Open checkout.”
2. “Keep it on the left and open the order draft on the right.”
3. “Focus the editor on the left.”
4. “Open `calculateFinalPrice`.”
5. “Show its actual callers.”
6. “Focus the editor on the right.”
7. “Close this pane.”
