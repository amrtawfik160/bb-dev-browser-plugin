# Show Browser Cards in chat

Owners often follow an agent's browser work from the thread rather than the
Browser Panel, and some sites need the owner to sign in before an agent can
continue. Asking for credentials in chat is unsafe, and a pasted link opens the
site on the displaying client, outside the Browser Profile.

The app registers two message directives. `::browser-live` renders a Browser
Card: the profile, its state, the active tab's title and address, and any
agent purpose, with an action that opens the thread's Browser Panel.
`::browser-sign-in{origin="…"}` renders a Sign-in Handoff for one exact
HTTP(S) origin. Its button opens the panel, then navigates it with the same
owner navigation the address bar uses. The owner signs in and clicks Done to
send a sign-in reply to the card's thread, starting an idle agent or steering
the reply into its active turn. The card confirms delivery, blocks repeat
clicks while sending or after success, and allows retry after a send failure.
Both cards default to the profile the thread's panel resolves. An
optional `profile-id` opens that profile in its own panel tab without changing
the thread's selection. Attributes are untrusted and validated before any RPC.

A card reads state through existing owner RPCs and never streams pixels. The
page stream stays a Browser Panel connection with its own Panel Capability
(ADR 0007); cards left in chat history would otherwise multiply owner-bound
streams. Reading tabs wakes a sleeping instance and counts as activity, so
cards read tabs only from an awake browser and refresh for two minutes after
mounting or a manual refresh. Addresses render as text, not links.

Agents embed at most one card per reply, and only when a person is likely
watching. A Sign-in Handoff is the last thing in its reply, and the agent then
ends its turn; if sign-in is still pending when it checks back, it embeds the
card again. Agents never request or type owner credentials. Safe Login Mode
(ADR 0002) remains a separate owner-only flow; a handoff uses ordinary owner
control.
